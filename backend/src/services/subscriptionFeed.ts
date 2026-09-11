import { config } from '../config';
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
const DAY_MS = 24 * 60 * 60 * 1000;

export type SubscriptionFeedRefreshDeps = {
  pruneOlderThan?: (userId: string, cutoffIso: string) => number;
  listSites: (userId: string) => Promise<BooruSiteRecord[]>;
  getTags: (userId: string) => string[];
  getEngine: (engine: BooruEngineType) => BooruEngineModule | null | undefined;
  getState: (userId: string, siteId: string) => SubscriptionFeedState;
  getGeneration: (userId: string) => number;
  hasPostsForSite: (userId: string, siteId: string) => boolean;
  hasAnyPosts: (userId: string, siteId: string, remoteIds: string[]) => boolean;
  saveState: (
    userId: string,
    siteId: string,
    updates: Partial<Omit<SubscriptionFeedState, 'updatedAt'>>,
    generation: number
  ) => SubscriptionFeedState | null;
  upsertPosts: (
    userId: string,
    siteId: string,
    posts: RemotePost[],
    generation: number
  ) => boolean;
};

const defaultDeps: SubscriptionFeedRefreshDeps = {
  pruneOlderThan: subscriptionFeedRepo.pruneOlderThan,
  listSites: booruSitesRepo.listBooruSites,
  getTags: settingsRepo.getSubscriptionTags,
  getEngine,
  getState: subscriptionFeedRepo.getState,
  getGeneration: subscriptionFeedRepo.getGeneration,
  hasPostsForSite: subscriptionFeedRepo.hasPostsForSite,
  hasAnyPosts: subscriptionFeedRepo.hasAnyPosts,
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

const tagBatch = (
  tags: string[],
  start: number,
  batchSize: number
): { tags: string[]; nextIndex: number; wrapped: boolean } => {
  if (!tags.length) return { tags: [], nextIndex: 0, wrapped: false };
  const count = Math.min(tags.length, batchSize);
  const batch = Array.from(
    { length: count },
    (_, index) => tags[(start + index) % tags.length]
  );
  return {
    tags: batch,
    nextIndex: (start + count) % tags.length,
    wrapped: start + count >= tags.length
  };
};

const searchPage = async (
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  tags: string[],
  page: number
) =>
  engine.searchPosts!(site, {
    tags: queryTagsFor(site.engine, tags),
    sort: 'new',
    window: 'day',
    date: todayIso(),
    page,
    limit: 40
  });

const refreshSearchSite = async (
  userId: string,
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  tags: string[],
  signal: AbortSignal | undefined,
  deps: SubscriptionFeedRefreshDeps,
  generation: number
) => {
  if (!engine.searchPosts || tags.length === 0) return;
  if (signal?.aborted) throw signal.reason ?? new Error('Refresh cancelled');
  const state = deps.getState(userId, site.id);
  const batchSize = batchSizeFor(site.engine);
  const head = tagBatch(tags, state.headTagIndex, batchSize);
  const headResult = await searchPage(site, engine, head.tags, 1);
  if (!deps.upsertPosts(userId, site.id, headResult.posts, generation)) return;

  let nextTagIndex = state.nextTagIndex;
  let page = state.searchPage;
  let pageHadPosts = state.searchPageHadPosts;
  let searchExhausted = state.searchExhausted;
  for (
    let request = 1;
    request < MAX_QUERIES_PER_SITE && !searchExhausted;
    request += 1
  ) {
    if (signal?.aborted) throw signal.reason ?? new Error('Refresh cancelled');
    const batch = tagBatch(tags, nextTagIndex, batchSize);
    const result = await searchPage(site, engine, batch.tags, page);
    if (!deps.upsertPosts(userId, site.id, result.posts, generation)) return;
    pageHadPosts ||= result.posts.length > 0;
    nextTagIndex = batch.nextIndex;
    if (!batch.wrapped) continue;
    searchExhausted = !pageHadPosts;
    if (!searchExhausted) page += 1;
    pageHadPosts = false;
    break;
  }
  deps.saveState(
    userId,
    site.id,
    {
      headTagIndex: head.nextIndex,
      nextTagIndex,
      searchPage: page,
      searchPageHadPosts: pageHadPosts,
      searchExhausted,
      lastError: null
    },
    generation
  );
};

const remoteIds = (posts: RemotePost[]): string[] =>
  posts.map((post) => post.remoteId);

const refreshMergedSite = async (
  userId: string,
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  signal: AbortSignal | undefined,
  deps: SubscriptionFeedRefreshDeps,
  generation: number
) => {
  if (!engine.fetchSubscriptionPosts) return;
  if (signal?.aborted) throw signal.reason ?? new Error('Refresh cancelled');
  const state = deps.getState(userId, site.id);
  const hadPosts = deps.hasPostsForSite(userId, site.id);
  const head = await engine.fetchSubscriptionPosts(site, null);
  const headReachedKnown = deps.hasAnyPosts(
    userId,
    site.id,
    remoteIds(head.posts)
  );
  if (!deps.upsertPosts(userId, site.id, head.posts, generation)) return;

  let headCursor = state.feedHeadCursor;
  if (!headCursor && hadPosts && !headReachedKnown) {
    headCursor = head.nextCursor;
  }
  for (let request = 0; request < 2 && headCursor; request += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error('Refresh cancelled');
    const forward = await engine.fetchSubscriptionPosts(site, headCursor);
    const reachedKnown = deps.hasAnyPosts(
      userId,
      site.id,
      remoteIds(forward.posts)
    );
    if (!deps.upsertPosts(userId, site.id, forward.posts, generation)) return;
    headCursor = reachedKnown ? null : forward.nextCursor;
  }

  let nextCursor = state.feedCursor ?? (!hadPosts ? head.nextCursor : null);
  let exhausted = state.feedExhausted || nextCursor === null;
  if (state.feedCursor && !state.feedExhausted) {
    if (signal?.aborted) throw signal.reason ?? new Error('Refresh cancelled');
    const backfill = await engine.fetchSubscriptionPosts(site, state.feedCursor);
    if (!deps.upsertPosts(userId, site.id, backfill.posts, generation)) return;
    nextCursor = backfill.nextCursor;
    exhausted = backfill.nextCursor === null;
  }
  deps.saveState(
    userId,
    site.id,
    {
      feedCursor: nextCursor,
      feedHeadCursor: headCursor,
      feedExhausted: exhausted,
      lastError: null
    },
    generation
  );
};

export type SubscriptionFeedRefreshResult = {
  errors: Array<{ siteId: string; siteName: string; error: string }>;
};

export const refreshSubscriptionFeedForUser = async (
  userId: string,
  signal?: AbortSignal,
  deps: SubscriptionFeedRefreshDeps = defaultDeps
): Promise<SubscriptionFeedRefreshResult> => {
  const retentionDays = config.subscriptions.feedRetentionDays;
  if (retentionDays > 0) {
    deps.pruneOlderThan?.(
      userId,
      new Date(Date.now() - retentionDays * DAY_MS).toISOString()
    );
  }
  const tags = deps.getTags(userId);
  const generation = deps.getGeneration(userId);
  const sites = (await deps.listSites(userId)).filter((site) => site.enabled);
  const settled = await Promise.allSettled(
    sites.map(async (site) => {
      const engine = deps.getEngine(site.engine);
      if (!engine) return;
      if (engine.fetchSubscriptionPosts) {
        await refreshMergedSite(userId, site, engine, signal, deps, generation);
      } else {
        await refreshSearchSite(
          userId,
          site,
          engine,
          tags,
          signal,
          deps,
          generation
        );
      }
    })
  );
  const errors: SubscriptionFeedRefreshResult['errors'] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    const site = sites[index];
    const error = redactUrlSecrets((result.reason as Error).message).slice(
      0,
      500
    );
    deps.saveState(userId, site.id, { lastError: error }, generation);
    errors.push({ siteId: site.id, siteName: site.name, error });
  });
  return { errors };
};

type ActiveRefresh = {
  generation: number;
  promise: Promise<SubscriptionFeedRefreshResult>;
};

const activeRefreshes = new Map<string, ActiveRefresh>();

export const resetSubscriptionFeed = (userId: string): void => {
  subscriptionFeedRepo.clearForUser(userId);
};

/**
 * The reset a tag change calls for. Tags only shape what the search-based
 * sites collect; a site with a feed of its own (FurAffinity's watchlist)
 * keeps its posts, which its site would not hand back a second time.
 */
export const resetTagSubscriptionFeed = async (userId: string): Promise<void> => {
  const sites = await booruSitesRepo.listBooruSites(userId);
  subscriptionFeedRepo.clearForUser(
    userId,
    sites
      .filter((site) => !getEngine(site.engine)?.fetchSubscriptionPosts)
      .map((site) => site.id)
  );
};

export const refreshSubscriptionFeed = (
  userId: string,
  signal?: AbortSignal
): Promise<SubscriptionFeedRefreshResult> => {
  const generation = subscriptionFeedRepo.getGeneration(userId);
  const active = activeRefreshes.get(userId);
  if (active?.generation === generation) return active.promise;
  const refresh = refreshSubscriptionFeedForUser(userId, signal).finally(() => {
    if (activeRefreshes.get(userId)?.promise === refresh) {
      activeRefreshes.delete(userId);
    }
  });
  activeRefreshes.set(userId, { generation, promise: refresh });
  return refresh;
};
