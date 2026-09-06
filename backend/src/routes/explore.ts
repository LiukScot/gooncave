import { FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { favoritesRepo } from '../db/repos/favoritesRepo';
import type { BooruSiteRecord } from '../db/types';
import { getEngine } from '../lib/booruEngines';
import { redactUrlSecrets } from '../lib/booruEngines/helpers';
import { todayIso } from '../lib/booruEngines/windowRange';
import { assertUrlAllowed, SsrfBlockedError } from '../lib/ssrfGuard';
import { mergeExplorePosts, type ExplorePost } from '../services/explore';
import {
  favoriteFromExplore,
  favoriteKeyForSite,
  unfavoriteFromExplore
} from '../services/favorites';
import {
  describePostPools,
  readPoolPage,
  readSinglePost
} from '../services/pools';
import { listRelatedPosts } from '../services/postRelations';

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

const postTagsSchema = z.object({
  siteId: z.string().min(1),
  remoteId: z.string().min(1).max(50)
});

const postRelationsSchema = z.object({
  siteId: z.string().min(1),
  remoteId: z.string().min(1).max(50),
  /** The post's parent, as the search result reported it. Not numeric on
      every booru: sankaku hands out alphanumeric ids. */
  parentId: z.string().min(1).max(50).optional(),
  hasChildren: z.enum(['true', 'false']).optional().default('false')
});

const postPoolsSchema = z.object({
  siteId: z.string().min(1),
  remoteId: z.string().min(1).max(50),
  /** What the search result already said, so e621 costs no extra read. */
  poolIds: z.string().max(500).optional()
});

const singlePostSchema = z.object({
  siteId: z.string().min(1),
  remoteId: z.string().min(1).max(50)
});

const poolPageSchema = z.object({
  siteId: z.string().min(1),
  poolId: z.string().min(1).max(50),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1)
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
/**
 * The site a request names, or null once 404 has been answered. Six handlers
 * here ask the same question of the same repo and answer the same way.
 */
const siteOr404 = async (
  reply: FastifyReply,
  siteId: string,
  userId: string
): Promise<BooruSiteRecord | null> => {
  const site = await booruSitesRepo.getBooruSite(siteId, userId);
  if (site) return site;
  reply.code(404).send({ error: 'Site not found' });
  return null;
};

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

  /**
   * The categorised tags of a single post. Search results carry whatever the
   * listing API reports, which on gelbooru-style boorus is every tag filed
   * under 'general' (issue #311). The detail view asks for the real ones,
   * one post at a time, because that is the only place they are shown.
   */
  app.get(
    '/explore/post-tags',
    { config: { rateLimit: exploreSearchRateLimit } },
    async (request, reply) => {
      const parsed = postTagsSchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid query', issues: parsed.error.issues };
      }
      const site = await siteOr404(
        reply,
        parsed.data.siteId,
        request.currentUser!.id
      );
      if (!site) return reply;
      const engine = getEngine(site.engine);
      if (!engine) {
        reply.code(400);
        return { error: `Unknown engine ${site.engine}` };
      }
      return { tags: await engine.fetchPostTags(site, parsed.data.remoteId) };
    }
  );

  /**
   * The parent/child group one post belongs to. The search result already
   * says whether there is one, so the caller passes that along and a post
   * standing on its own never reaches a booru at all.
   */
  app.get(
    '/explore/post-relations',
    { config: { rateLimit: exploreSearchRateLimit } },
    async (request, reply) => {
      const parsed = postRelationsSchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid query', issues: parsed.error.issues };
      }
      const site = await siteOr404(
        reply,
        parsed.data.siteId,
        request.currentUser!.id
      );
      if (!site) return reply;
      const posts = await listRelatedPosts(
        site,
        parsed.data.remoteId,
        {
          parentId: parsed.data.parentId ?? null,
          hasChildren: parsed.data.hasChildren === 'true'
        },
        request.currentUser!.id
      );
      return { posts };
    }
  );

  /**
   * The pools the post belongs to, each with the pages either side of it.
   * Engines without pools answer with an empty list and reach no booru.
   */
  app.get(
    '/explore/post-pools',
    { config: { rateLimit: exploreSearchRateLimit } },
    async (request, reply) => {
      const parsed = postPoolsSchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid query', issues: parsed.error.issues };
      }
      const site = await siteOr404(
        reply,
        parsed.data.siteId,
        request.currentUser!.id
      );
      if (!site) return reply;
      const known =
        parsed.data.poolIds === undefined
          ? null
          : splitTags(parsed.data.poolIds);
      try {
        return {
          pools: await describePostPools(site, parsed.data.remoteId, known)
        };
      } catch (err) {
        // One row above the info section is not worth a failed page: a booru
        // that will not answer costs the navigator, nothing else.
        console.warn(
          `[pools] ${site.name} failed for ${parsed.data.remoteId}: ${redactUrlSecrets((err as Error).message)}`
        );
        return { pools: [] };
      }
    }
  );

  /**
   * One post by id, for a caller holding nothing else: the pool navigator's
   * Prev and Next, which carry ids so the block itself renders after a
   * single read.
   */
  app.get(
    '/explore/post',
    { config: { rateLimit: exploreSearchRateLimit } },
    async (request, reply) => {
      const parsed = singlePostSchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid query', issues: parsed.error.issues };
      }
      const site = await siteOr404(
        reply,
        parsed.data.siteId,
        request.currentUser!.id
      );
      if (!site) return reply;
      const post = await readSinglePost(
        site,
        parsed.data.remoteId,
        request.currentUser!.id
      );
      if (!post) {
        reply.code(404);
        return { error: 'Post not found' };
      }
      return { post };
    }
  );

  /** One page of a pool, in reading order. */
  app.get(
    '/explore/pool',
    { config: { rateLimit: exploreSearchRateLimit } },
    async (request, reply) => {
      const parsed = poolPageSchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid query', issues: parsed.error.issues };
      }
      const site = await siteOr404(
        reply,
        parsed.data.siteId,
        request.currentUser!.id
      );
      if (!site) return reply;
      const page = await readPoolPage(
        site,
        parsed.data.poolId,
        parsed.data.page,
        request.currentUser!.id
      );
      if (!page) {
        reply.code(404);
        return { error: 'Pool not found' };
      }
      return page;
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
      const site = await siteOr404(
        reply,
        parsed.data.siteId,
        request.currentUser!.id
      );
      if (!site) return reply;
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
