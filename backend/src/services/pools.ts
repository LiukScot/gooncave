import { filesRepo } from '../db/repos/filesRepo';
import type { BooruSiteRecord } from '../db/types';
import { getEngine } from '../lib/booruEngines';
import { redactUrlSecrets } from '../lib/booruEngines/helpers';
import type {
  BooruEngineModule,
  PoolRecord,
  RemotePost
} from '../lib/booruEngines/types';
import { createTtlCache } from '../lib/ttlCache';

import {
  postsByIds,
  toLibraryAwarePost,
  toLibraryAwarePosts,
  type LibraryAwarePost
} from './booruPosts';
import { remoteOrigins } from './postRelations';

/**
 * Pools: the ordered sets a booru files a comic, a scene or a scanned book
 * under. Unlike parent/child posts these carry an order, so everything here
 * keeps the booru's `post_ids` sequence rather than any sort of its own.
 */

/** One pool the open post belongs to, as the detail navigator shows it. */
export type PoolNavigator = {
  poolId: string;
  siteId: string;
  siteName: string;
  name: string;
  /** 1-based page number of the open post. */
  position: number;
  postCount: number;
  /**
   * Ids only. Reading the neighbouring posts up front doubled the requests
   * this block waits on — and on a post in two pools that was four reads
   * before anything appeared. The page is fetched when it is asked for.
   */
  prevId: string | null;
  nextId: string | null;
};

/** One page of a pool, as the pool view shows it. */
export type PoolPagePost = LibraryAwarePost & { position: number };

export type PoolPage = {
  poolId: string;
  siteId: string;
  siteName: string;
  name: string;
  postCount: number;
  page: number;
  pageSize: number;
  posts: PoolPagePost[];
  /** The whole pool's order, so the detail can step past this page. */
  postIds: string[];
};

export const POOL_PAGE_SIZE = 60;

/**
 * The `post_ids` list changes only when someone edits the pool, and both the
 * navigator and the pool view read it on every open. Kept for the same five
 * minutes the related-posts group is.
 */
const poolCache = createTtlCache<PoolRecord>(5 * 60_000, 200);
/** Pools of one post: e621 answers for free, danbooru costs a request. */
const postPoolsCache = createTtlCache<string[]>(5 * 60_000, 500);

const poolEngine = (site: BooruSiteRecord): BooruEngineModule | null => {
  const engine = getEngine(site.engine);
  if (!engine?.searchPosts || !engine.supportsPools || !engine.fetchPool) {
    return null;
  }
  return engine;
};

const readPool = async (
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  poolId: string
): Promise<PoolRecord | null> => {
  const key = `${site.id}:${poolId}`;
  const cached = poolCache.get(key);
  if (cached) return cached;
  const pool = await engine.fetchPool!(site, poolId);
  if (pool) poolCache.set(key, pool);
  return pool;
};

const readPools = (
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  poolIds: string[]
): Promise<(PoolRecord | null)[]> =>
  // Side by side: a post in two pools would otherwise wait for the first
  // booru read before starting the second.
  Promise.all(poolIds.map((poolId) => readPool(site, engine, poolId)));

const poolsForPost = async (
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  remoteId: string,
  known: string[] | null
): Promise<(PoolRecord | null)[]> => {
  // e621 puts them in every search result; passing them through spares the
  // extra read the other engines need.
  if (known) return readPools(site, engine, known);
  const key = `${site.id}:${remoteId}`;
  const cached = postPoolsCache.get(key);
  if (cached) return readPools(site, engine, cached);
  // danbooru's pool search hands back the pools whole: one read, and the
  // pool cache is filled on the way past.
  if (engine.fetchPostPools) {
    const pools = await engine.fetchPostPools(site, remoteId);
    for (const pool of pools) poolCache.set(`${site.id}:${pool.id}`, pool);
    postPoolsCache.set(
      key,
      pools.map((pool) => pool.id)
    );
    return pools;
  }
  if (!engine.fetchPostPoolIds) return [];
  const ids = await engine.fetchPostPoolIds(site, remoteId);
  postPoolsCache.set(key, ids);
  return readPools(site, engine, ids);
};

/**
 * The pools one post is a page of, each with the ids of the pages on either
 * side of it.
 *
 * `knownPoolIds` is what the caller already has — the explore grid gets them
 * inside every e621 post — and `null` when it has nothing, which is the case
 * for a file in the library.
 */
export const describePostPools = async (
  site: BooruSiteRecord,
  remoteId: string,
  knownPoolIds: string[] | null
): Promise<PoolNavigator[]> => {
  const engine = poolEngine(site);
  if (!engine) return [];
  const pools = await poolsForPost(site, engine, remoteId, knownPoolIds);
  const navigators: PoolNavigator[] = [];
  for (const pool of pools) {
    if (!pool) continue;
    const index = pool.postIds.indexOf(remoteId);
    // The pool no longer lists this post: showing a position in it would be
    // a lie, and there are no neighbours to move between.
    if (index === -1) continue;
    navigators.push({
      poolId: pool.id,
      siteId: site.id,
      siteName: site.name,
      name: pool.name,
      position: index + 1,
      postCount: pool.postIds.length,
      prevId: pool.postIds[index - 1] ?? null,
      nextId: pool.postIds[index + 1] ?? null
    });
  }
  return navigators;
};

/**
 * One post, for a caller that has an id and nothing else — the pool
 * navigator's Prev and Next. Cached, so stepping back and forth through a
 * pool re-reads nothing.
 */
const singlePostCache = createTtlCache<RemotePost>(5 * 60_000, 300);

export const readSinglePost = async (
  site: BooruSiteRecord,
  remoteId: string,
  userId: string
): Promise<LibraryAwarePost | null> => {
  const engine = getEngine(site.engine);
  if (!engine?.searchPosts) return null;
  const key = `${site.id}:${remoteId}`;
  const cached = singlePostCache.get(key);
  const post = cached ?? (await postsByIds(site, engine, [remoteId]))[0];
  if (!post) return null;
  singlePostCache.set(key, post);
  return toLibraryAwarePost(site, engine, post, userId);
};

/**
 * The pools of a file in the library, through the post its tags came from.
 * The relations row written when the tags were read already carries the
 * pool ids on engines whose listing names them, which saves the post read.
 */
export const describeFilePools = async (
  fileId: string,
  userId: string
): Promise<PoolNavigator[]> => {
  const stored = await filesRepo.listRelationsForFile(fileId);
  for (const origin of await remoteOrigins(fileId, userId)) {
    const known = stored.find(
      (entry) =>
        entry.source === origin.source && entry.remoteId === origin.remoteId
    );
    try {
      const pools = await describePostPools(
        origin.site,
        origin.remoteId,
        known?.poolIds ?? null
      );
      if (pools.length) return pools;
    } catch (err) {
      // A site that will not answer must not take the detail view down with
      // it: this block is one row above the info section, not the page.
      console.warn(
        `[pools] ${origin.site.name} failed for file ${fileId}: ${redactUrlSecrets((err as Error).message)}`
      );
    }
  }
  return [];
};

/** One page of a pool, in reading order. */
export const readPoolPage = async (
  site: BooruSiteRecord,
  poolId: string,
  page: number,
  userId: string
): Promise<PoolPage | null> => {
  const engine = poolEngine(site);
  if (!engine) return null;
  const pool = await readPool(site, engine, poolId);
  if (!pool) return null;
  const start = (page - 1) * POOL_PAGE_SIZE;
  const ids = pool.postIds.slice(start, start + POOL_PAGE_SIZE);
  const posts = await postsByIds(site, engine, ids);
  const resolved = (await toLibraryAwarePosts(site, engine, posts, userId)).map(
    (post) => ({
      ...post,
      // Counted in the pool, not in this page: page three opens at 121.
      position: pool.postIds.indexOf(post.remoteId) + 1
    })
  );
  return {
    poolId: pool.id,
    siteId: site.id,
    siteName: site.name,
    name: pool.name,
    postCount: pool.postIds.length,
    page,
    pageSize: POOL_PAGE_SIZE,
    posts: resolved,
    postIds: pool.postIds
  };
};
