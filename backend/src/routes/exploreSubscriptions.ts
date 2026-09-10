import { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { favoritesRepo } from '../db/repos/favoritesRepo';
import { subscriptionFeedRepo } from '../db/repos/subscriptionFeedRepo';
import type { BooruSiteRecord } from '../db/types';
import { getEngine } from '../lib/booruEngines';
import type { ExplorePost } from '../services/explore';
import { favoriteKeyForSite } from '../services/favorites';
import { refreshSubscriptionFeed } from '../services/subscriptionFeed';

const feedSchema = z.object({
  sites: z.string().max(2000).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(40)
});

const cursorSchema = z.object({
  sortAt: z.string().datetime(),
  discoveredAt: z.string().datetime(),
  siteId: z.string().min(1),
  remoteId: z.string().min(1)
});

const decodeCursor = (raw: string | undefined) => {
  if (!raw) return undefined;
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    );
  } catch {
    return null;
  }
};

const splitSiteIds = (raw: string | undefined): string[] | undefined =>
  raw
    ?.split(/[,\s]+/)
    .map((siteId) => siteId.trim())
    .filter(Boolean);

const hydratePosts = async (
  userId: string,
  items: ReturnType<typeof subscriptionFeedRepo.listPosts>['items']
): Promise<ExplorePost[]> => {
  const uniqueSites = new Map(items.map(({ site }) => [site.id, site]));
  const fullSites = new Map<string, BooruSiteRecord>();
  const savedRemoteIds = new Map<string, Set<string>>();
  await Promise.all(
    [...uniqueSites.values()].map(async (site) => {
      const fullSite = await booruSitesRepo.getBooruSite(site.id, userId);
      if (!fullSite) return;
      fullSites.set(site.id, fullSite);
      const favorites = await favoritesRepo.listFavoriteItems(
        favoriteKeyForSite(fullSite),
        userId
      );
      savedRemoteIds.set(
        site.id,
        new Set(favorites.map((favorite) => favorite.remoteId))
      );
    })
  );
  return items.flatMap(({ site, post }) => {
    const engine = getEngine(site.engine);
    const fullSite = fullSites.get(site.id);
    if (!engine || !fullSite) return [];
    return [
      {
        ...post,
        favorited:
          post.favorited ??
          savedRemoteIds.get(site.id)?.has(post.remoteId) ??
          false,
        siteId: site.id,
        siteName: site.name,
        engine: site.engine,
        sourceUrl: engine.buildPostUrl(fullSite, post.remoteId)
      }
    ];
  });
};

export const registerExploreSubscriptionRoutes = (app: FastifyInstance) => {
  app.get(
    '/explore/subscriptions',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = feedSchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid query', issues: parsed.error.issues };
      }
      const cursor = decodeCursor(parsed.data.cursor);
      if (cursor === null) {
        reply.code(400);
        return { error: 'Invalid subscription cursor' };
      }
      const page = subscriptionFeedRepo.listPosts(request.currentUser!.id, {
        siteIds: splitSiteIds(parsed.data.sites),
        cursor,
        limit: parsed.data.limit
      });
      return {
        posts: await hydratePosts(request.currentUser!.id, page.items),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor
          ? Buffer.from(JSON.stringify(page.nextCursor)).toString('base64url')
          : null
      };
    }
  );

  app.post(
    '/explore/subscriptions/refresh',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => refreshSubscriptionFeed(request.currentUser!.id)
  );
};
