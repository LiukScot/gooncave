import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { settingsRepo } from '../db/repos/settingsRepo';
import {
  subscriptionFeedRepo,
  type SubscriptionFeedState
} from '../db/repos/subscriptionFeedRepo';
import type { BooruEngineType, BooruSiteRecord } from '../db/types';
import { getEngine } from '../lib/booruEngines';
import { redactUrlSecrets } from '../lib/booruEngines/helpers';
import type { BooruEngineModule, RemotePost } from '../lib/booruEngines/types';
import { todayIso } from '../lib/booruEngines/windowRange';

const MAX_QUERIES_PER_SITE = 4;

export type SubscriptionFeedRefreshDeps = {
  listSites: (userId: string) => Promise<BooruSiteRecord[]>;
  getTags: (userId: string) => string[];
  getEngine: (engine: BooruEngineType) => BooruEngineModule | null | undefined;
  getState: (userId: string, siteId: string) => SubscriptionFeedState;
  saveState: (
    userId: string,
    siteId: string,
    updates: Partial<Omit<SubscriptionFeedState, 'updatedAt'>>
  ) => unknown;
  upsertPosts: (userId: string, siteId: string, posts: RemotePost[]) => void;
};

const defaultDeps: SubscriptionFeedRefreshDeps = {
  listSites: booruSitesRepo.listBooruSites,
  getTags: settingsRepo.getSubscriptionTags,
  getEngine,
  getState: subscriptionFeedRepo.getState,
  saveState: subscriptionFeedRepo.saveState,
  upsertPosts: subscriptionFeedRepo.upsertPosts
};

const batchSizeFor = (engine: BooruEngineType): number => {
  if (engine === 'e621') return 40;
  if (engine === 'danbooru') return 2;
  return 1;
};

const queryTagsFor = (engine: BooruEngineType, tags: string[]): string[] =>
  engine === 'e621' || engine === 'danbooru'
    ? tags.map((tag) => `~${tag}`)
    : tags;

const tagBatches = (
  tags: string[],
  start: number,
  batchSize: number
): { batches: string[][]; nextIndex: number } => {
  if (!tags.length) return { batches: [], nextIndex: 0 };
  const count = Math.min(tags.length, batchSize * MAX_QUERIES_PER_SITE);
  const ordered = Array.from(
    { length: count },
    (_, index) => tags[(start + index) % tags.length]
  );
  const batches: string[][] = [];
  for (let index = 0; index < ordered.length; index += batchSize) {
    batches.push(ordered.slice(index, index + batchSize));
  }
  return {
    batches,
    nextIndex: (start + count) % tags.length
  };
};

const refreshSearchSite = async (
  userId: string,
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  tags: string[],
  signal: AbortSignal | undefined,
  deps: SubscriptionFeedRefreshDeps
) => {
  if (!engine.searchPosts || tags.length === 0) return;
  const state = deps.getState(userId, site.id);
  const { batches, nextIndex } = tagBatches(
    tags,
    state.nextTagIndex,
    batchSizeFor(site.engine)
  );
  for (const batch of batches) {
    if (signal?.aborted) throw signal.reason ?? new Error('Refresh cancelled');
    const result = await engine.searchPosts(site, {
      tags: queryTagsFor(site.engine, batch),
      sort: 'new',
      window: 'day',
      date: todayIso(),
      page: 1,
      limit: 40
    });
    deps.upsertPosts(userId, site.id, result.posts);
  }
  deps.saveState(userId, site.id, { nextTagIndex: nextIndex, lastError: null });
};

const refreshMergedSite = async (
  userId: string,
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  signal: AbortSignal | undefined,
  deps: SubscriptionFeedRefreshDeps
) => {
  if (!engine.fetchSubscriptionPosts) return;
  if (signal?.aborted) throw signal.reason ?? new Error('Refresh cancelled');
  const state = deps.getState(userId, site.id);
  const head = await engine.fetchSubscriptionPosts(site, null);
  deps.upsertPosts(userId, site.id, head.posts);
  let nextCursor = state.feedCursor ?? head.nextCursor;
  let exhausted = head.nextCursor === null;
  if (state.feedCursor && !state.feedExhausted) {
    if (signal?.aborted) throw signal.reason ?? new Error('Refresh cancelled');
    const backfill = await engine.fetchSubscriptionPosts(site, state.feedCursor);
    deps.upsertPosts(userId, site.id, backfill.posts);
    nextCursor = backfill.nextCursor;
    exhausted = backfill.nextCursor === null;
  }
  deps.saveState(userId, site.id, {
    feedCursor: nextCursor,
    feedExhausted: exhausted,
    lastError: null
  });
};

export type SubscriptionFeedRefreshResult = {
  errors: Array<{ siteId: string; siteName: string; error: string }>;
};

export const refreshSubscriptionFeedForUser = async (
  userId: string,
  signal?: AbortSignal,
  deps: SubscriptionFeedRefreshDeps = defaultDeps
): Promise<SubscriptionFeedRefreshResult> => {
  const tags = deps.getTags(userId);
  const sites = (await deps.listSites(userId)).filter((site) => site.enabled);
  const settled = await Promise.allSettled(
    sites.map(async (site) => {
      const engine = deps.getEngine(site.engine);
      if (!engine) return;
      if (engine.fetchSubscriptionPosts) {
        await refreshMergedSite(userId, site, engine, signal, deps);
      } else {
        await refreshSearchSite(userId, site, engine, tags, signal, deps);
      }
    })
  );
  const errors: SubscriptionFeedRefreshResult['errors'] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    const site = sites[index];
    const error = redactUrlSecrets((result.reason as Error).message).slice(0, 500);
    deps.saveState(userId, site.id, { lastError: error });
    errors.push({ siteId: site.id, siteName: site.name, error });
  });
  return { errors };
};

const activeRefreshes = new Map<string, Promise<SubscriptionFeedRefreshResult>>();

export const resetSubscriptionFeed = async (userId: string): Promise<void> => {
  await activeRefreshes.get(userId)?.catch(() => undefined);
  subscriptionFeedRepo.clearForUser(userId);
};

export const refreshSubscriptionFeed = (
  userId: string,
  signal?: AbortSignal
): Promise<SubscriptionFeedRefreshResult> => {
  const active = activeRefreshes.get(userId);
  if (active) return active;
  const refresh = refreshSubscriptionFeedForUser(userId, signal).finally(() => {
    activeRefreshes.delete(userId);
  });
  activeRefreshes.set(userId, refresh);
  return refresh;
};
