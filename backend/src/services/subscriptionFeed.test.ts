import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';

import { test } from 'bun:test';

import type { BooruSiteRecord } from '../db/types';
import type { BooruEngineModule, RemotePost } from '../lib/booruEngines/types';

import {
  refreshSubscriptionFeedForUser,
  type SubscriptionFeedRefreshDeps
} from './subscriptionFeed';

const site = (id: string, engine: BooruSiteRecord['engine']): BooruSiteRecord => ({
  id,
  userId: 'user',
  name: id,
  engine,
  baseUrl: `https://${id}.test`,
  username: null,
  apiKey: null,
  sessionCookie: null,
  isPreset: false,
  presetKey: null,
  enabled: true,
  siteAutoSyncMidnight: false,
  siteReverseSyncEnabled: false,
  siteAutoFavEnabled: false,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
});

const post = (remoteId: string): RemotePost => ({
  remoteId,
  previewUrl: null,
  sampleUrl: null,
  fileUrl: null,
  width: null,
  height: null,
  score: null,
  rating: null,
  md5: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  tags: [],
  favCount: null,
  uploader: null,
  fileExt: null,
  fileSize: null,
  favorited: null,
  voted: null,
  parentId: null,
  hasChildren: false,
  poolIds: null
});

const initialState = () => ({
  nextTagIndex: 0,
  headTagIndex: 0,
  searchPage: 2,
  searchPageHadPosts: false,
  searchExhausted: false,
  feedCursor: null,
  feedHeadCursor: null,
  feedExhausted: false,
  updatedAt: new Date(0).toISOString(),
  lastError: null
});

const dependencies = (
  overrides: Partial<SubscriptionFeedRefreshDeps>
): SubscriptionFeedRefreshDeps => ({
  listSites: async () => [],
  getTags: () => [],
  getEngine: () => null,
  getState: initialState,
  getGeneration: () => 0,
  hasPostsForSite: () => false,
  hasAnyPosts: () => false,
  saveState: () => initialState(),
  upsertPosts: () => true,
  ...overrides
});

test('search refresh keeps page one fresh while advancing through older pages', async () => {
  const source = site('source', 'e621');
  const calls: Array<{ tags: string[]; page: number }> = [];
  const savedPosts: string[] = [];
  let state = initialState();
  const engine = {
    searchPosts: async (_site, options) => {
      calls.push({ tags: options.tags, page: options.page });
      return {
        posts: options.page <= 3 ? [post(`page-${options.page}`)] : [],
        downloadHeaders: {}
      };
    }
  } as Pick<BooruEngineModule, 'searchPosts'>;
  const deps = dependencies({
    listSites: async () => [source],
    getTags: () => ['subject'],
    getEngine: () => engine as BooruEngineModule,
    getState: () => state,
    saveState: (_userId, _siteId, updates) => {
      state = { ...state, ...updates };
      return state;
    },
    upsertPosts: (_userId, _siteId, posts) => {
      savedPosts.push(...posts.map((entry) => entry.remoteId));
      return true;
    }
  });

  await refreshSubscriptionFeedForUser('user', undefined, deps);
  await refreshSubscriptionFeedForUser('user', undefined, deps);

  assert.deepEqual(
    calls.map(({ page }) => page),
    [1, 2, 1, 3]
  );
  assert.ok(calls.every(({ tags }) => tags[0] === '~subject'));
  assert.deepEqual(savedPosts, ['page-1', 'page-2', 'page-1', 'page-3']);
  assert.equal(state.searchPage, 4);
});

test('merged refresh closes a new-post gap without abandoning old backfill', async () => {
  const source = site('source', 'furaffinity');
  const calls: Array<string | null> = [];
  const known = new Set(['new-1', 'known']);
  let state = {
    ...initialState(),
    feedCursor: 'old-tail',
    feedHeadCursor: 'new-gap-1'
  };
  const pages: Record<string, { posts: RemotePost[]; nextCursor: string | null }> = {
    head: { posts: [post('new-1')], nextCursor: 'new-gap-1' },
    'new-gap-1': { posts: [post('new-2')], nextCursor: 'new-gap-2' },
    'new-gap-2': { posts: [post('known')], nextCursor: 'after-known' },
    'old-tail': { posts: [post('old-1')], nextCursor: 'older-tail' }
  };
  const engine = {
    fetchSubscriptionPosts: async (_site, cursor) => {
      calls.push(cursor);
      return pages[cursor ?? 'head'];
    }
  } as Pick<BooruEngineModule, 'fetchSubscriptionPosts'>;
  const deps = dependencies({
    listSites: async () => [source],
    getEngine: () => engine as BooruEngineModule,
    getState: () => state,
    hasPostsForSite: () => true,
    hasAnyPosts: (_userId, _siteId, ids) =>
      ids.some((remoteId) => known.has(remoteId)),
    upsertPosts: (_userId, _siteId, posts) => {
      posts.forEach((entry) => known.add(entry.remoteId));
      return true;
    },
    saveState: (_userId, _siteId, updates) => {
      state = { ...state, ...updates };
      return state;
    }
  });

  await refreshSubscriptionFeedForUser('user', undefined, deps);

  assert.deepEqual(calls, [null, 'new-gap-1', 'new-gap-2', 'old-tail']);
  assert.equal(state.feedHeadCursor, null);
  assert.equal(state.feedCursor, 'older-tail');
});

test('refresh stops writing after another process invalidates its generation', async () => {
  const source = site('source', 'e621');
  let generation = 4;
  let writes = 0;
  const deps = dependencies({
    listSites: async () => [source],
    getTags: () => ['subject'],
    getEngine: () =>
      ({
        searchPosts: async () => {
          generation = 5;
          return { posts: [post('stale')], downloadHeaders: {} };
        }
      }) as BooruEngineModule,
    getGeneration: () => 4,
    upsertPosts: (_userId, _siteId, _posts, expectedGeneration) => {
      if (expectedGeneration !== generation) return false;
      writes += 1;
      return true;
    }
  });

  const result = await refreshSubscriptionFeedForUser('user', undefined, deps);

  assert.deepEqual(result.errors, []);
  assert.equal(writes, 0);
});

test('refresh isolates a failing source so another source still updates', async () => {
  const broken = site('broken', 'danbooru');
  const healthy = site('healthy', 'gelbooru');
  const savedSites: string[] = [];
  const deps = dependencies({
    listSites: async () => [broken, healthy],
    getTags: () => ['subject'],
    getEngine: (engine) =>
      ({
        type: engine,
        searchPosts: async (_site, options) => {
          if (engine === 'danbooru') throw new Error('temporarily unavailable');
          return {
            posts: options.page === 1 ? [post('healthy-post')] : [],
            downloadHeaders: {}
          };
        }
      }) as BooruEngineModule,
    upsertPosts: (_userId, siteId) => {
      savedSites.push(siteId);
      return true;
    }
  });

  const result = await refreshSubscriptionFeedForUser('user', undefined, deps);

  assert.deepEqual(savedSites, ['healthy', 'healthy']);
  assert.deepEqual(result.errors.map((entry) => entry.siteId), ['broken']);
});
