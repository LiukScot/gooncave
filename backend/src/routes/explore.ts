import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { favoritesRepo } from '../db/repos/favoritesRepo';
import type { BooruSiteRecord } from '../db/types';
import { getEngine } from '../lib/booruEngines';
import { todayIso } from '../lib/booruEngines/windowRange';
import { assertUrlAllowed, SsrfBlockedError } from '../lib/ssrfGuard';
import { mergeExplorePosts, type ExplorePost } from '../services/explore';
import {
  favoriteFromExplore,
  favoriteKeyForSite,
  unfavoriteFromExplore
} from '../services/favorites';

const searchSchema = z.object({
  tags: z.string().max(500).optional().default(''),
  sort: z.enum(['new', 'hot', 'popular']).optional().default('new'),
  window: z.enum(['day', 'week', 'month']).optional().default('day'),
  /** Any date inside the period to show; defaults to the current one. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
  /** Comma-separated site ids; omitted = every searchable site. */
  sites: z.string().max(2000).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(40)
});

const voteSchema = z.object({
  siteId: z.string().min(1),
  remoteId: z.string().min(1).max(50),
  score: z.union([z.literal(1), z.literal(-1)])
});

const favoriteSchema = z.object({
  siteId: z.string().min(1),
  remoteId: z.string().min(1).max(50),
  fileUrl: z.string().url()
});

const unfavoriteSchema = z.object({
  siteId: z.string().min(1),
  remoteId: z.string().min(1).max(50)
});

const searchableSites = async (userId: string): Promise<BooruSiteRecord[]> => {
  const sites = await booruSitesRepo.listBooruSites(userId);
  return sites.filter(
    (site) => site.enabled && Boolean(getEngine(site.engine)?.searchPosts)
  );
};

const splitTags = (raw: string): string[] =>
  raw
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);

// One request now covers one site, where it used to fan out to all of them:
// the browser merges the pages itself so it can ask the site that is holding
// the ranking back. Same load on the boorus, more calls to reach it.
const exploreSearchRateLimit = { max: 240, timeWindow: '1 minute' };
const exploreActionRateLimit = { max: 30, timeWindow: '1 minute' };

export const registerExploreRoutes = (app: FastifyInstance) => {
  app.get(
    '/explore/posts',
    { config: { rateLimit: exploreSearchRateLimit } },
    async (request, reply) => {
      const parsed = searchSchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid query', issues: parsed.error.issues };
      }
      const { sort, window, page, limit } = parsed.data;
      const date = parsed.data.date ?? todayIso();
      const tags = splitTags(parsed.data.tags);
      let sites = await searchableSites(request.currentUser!.id);
      if (parsed.data.sites !== undefined) {
        const wanted = new Set(splitTags(parsed.data.sites));
        sites = sites.filter((site) => wanted.has(site.id));
      }
      if (!sites.length) {
        return { posts: [], siteErrors: [], sites: [] };
      }
      const settled = await Promise.allSettled(
        sites.map((site) =>
          getEngine(site.engine)!.searchPosts!(site, {
            tags,
            sort,
            window,
            date,
            page,
            limit
          })
        )
      );
      // Posts already in the library must come back marked, or every reload
      // would present them as unsaved. Read once per site rather than per
      // post: a page of 40 would otherwise be 40 lookups.
      const savedRemoteIds = new Map<string, Set<string>>();
      await Promise.all(
        sites.map(async (site) => {
          const items = await favoritesRepo.listFavoriteItems(
            favoriteKeyForSite(site),
            request.currentUser!.id
          );
          savedRemoteIds.set(
            site.id,
            new Set(items.map((item) => item.remoteId))
          );
        })
      );

      const bySite: ExplorePost[][] = [];
      const siteErrors: { siteId: string; siteName: string; error: string }[] =
        [];
      settled.forEach((result, index) => {
        const site = sites[index];
        if (result.status === 'rejected') {
          siteErrors.push({
            siteId: site.id,
            siteName: site.name,
            error: (result.reason as Error).message
          });
          return;
        }
        const engine = getEngine(site.engine)!;
        bySite.push(
          result.value.posts.map((post) => ({
            ...post,
            // The booru's own answer wins where it gives one: it knows about
            // favorites made elsewhere that never reached this library.
            favorited:
              post.favorited ??
              savedRemoteIds.get(site.id)?.has(post.remoteId) ??
              false,
            siteId: site.id,
            siteName: site.name,
            engine: site.engine,
            sourceUrl: engine.buildPostUrl(site, post.remoteId)
          }))
        );
      });
      return {
        posts: mergeExplorePosts(bySite, sort),
        siteErrors,
        sites: sites.map((site) => site.id)
      };
    }
  );

  app.post(
    '/explore/vote',
    { config: { rateLimit: exploreActionRateLimit } },
    async (request, reply) => {
      const parsed = voteSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid payload', issues: parsed.error.issues };
      }
      const site = await booruSitesRepo.getBooruSite(
        parsed.data.siteId,
        request.currentUser!.id
      );
      if (!site) {
        reply.code(404);
        return { error: 'Site not found' };
      }
      const engine = getEngine(site.engine);
      if (!engine?.vote) {
        reply.code(400);
        return { error: `${site.name} does not support voting` };
      }
      await engine.vote(site, parsed.data.remoteId, parsed.data.score);
      return { ok: true };
    }
  );

  app.post(
    '/explore/favorite',
    { config: { rateLimit: exploreActionRateLimit } },
    async (request, reply) => {
      const parsed = favoriteSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid payload', issues: parsed.error.issues };
      }
      // The download URL comes from the client; block private targets before
      // it ever reaches the downloader (which re-checks via safeFetch).
      try {
        await assertUrlAllowed(parsed.data.fileUrl);
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          reply.code(400);
          return { error: err.message };
        }
        throw err;
      }
      const result = await favoriteFromExplore(
        request.currentUser!.id,
        parsed.data.siteId,
        parsed.data.remoteId,
        parsed.data.fileUrl
      );
      return { ok: true, ...result };
    }
  );

  app.post(
    '/explore/unfavorite',
    { config: { rateLimit: exploreActionRateLimit } },
    async (request, reply) => {
      const parsed = unfavoriteSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid payload', issues: parsed.error.issues };
      }
      const result = await unfavoriteFromExplore(
        request.currentUser!.id,
        parsed.data.siteId,
        parsed.data.remoteId
      );
      return { ok: true, ...result };
    }
  );
};
