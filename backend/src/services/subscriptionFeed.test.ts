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

test('refresh groups OR-capable subscriptions and advances the persistent scan position', async () => {
  const source = site('source', 'e621');
  const calls: string[][] = [];
  const savedPosts: RemotePost[][] = [];
  let savedIndex = -1;
  const engine = {
    searchPosts: async (_site, options) => {
      calls.push(options.tags);
      return { posts: [post(String(calls.length))], downloadHeaders: {} };
    }
  } as Pick<BooruEngineModule, 'searchPosts'>;
  const deps: SubscriptionFeedRefreshDeps = {
    listSites: async () => [source],
    getTags: () => Array.from({ length: 45 }, (_, index) => `tag_${index}`),
    getEngine: () => engine as BooruEngineModule,
    getState: () => ({
      nextTagIndex: 0,
      feedCursor: null,
      feedExhausted: false,
      updatedAt: new Date(0).toISOString(),
      lastError: null
    }),
    saveState: (_userId, _siteId, updates) => {
      savedIndex = updates.nextTagIndex ?? -1;
    },
    upsertPosts: (_userId, _siteId, posts) => savedPosts.push(posts)
  };

  const result = await refreshSubscriptionFeedForUser('user', undefined, deps);

  assert.equal(result.errors.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, 40);
  assert.ok(calls[0].every((tag) => tag.startsWith('~')));
  assert.deepEqual(calls[1], ['~tag_40', '~tag_41', '~tag_42', '~tag_43', '~tag_44']);
  assert.equal(savedIndex, 0);
  assert.equal(savedPosts.flat().length, 2);
});

test('refresh isolates a failing source so another source still updates', async () => {
  const broken = site('broken', 'danbooru');
  const healthy = site('healthy', 'gelbooru');
  const savedSites: string[] = [];
  const deps: SubscriptionFeedRefreshDeps = {
    listSites: async () => [broken, healthy],
    getTags: () => ['subject'],
    getEngine: (engine) =>
      ({
        type: engine,
        searchPosts: async () => {
          if (engine === 'danbooru') throw new Error('temporarily unavailable');
          return { posts: [post('healthy-post')], downloadHeaders: {} };
        }
      }) as BooruEngineModule,
    getState: () => ({
      nextTagIndex: 0,
      feedCursor: null,
      feedExhausted: false,
      updatedAt: new Date(0).toISOString(),
      lastError: null
    }),
    saveState: () => undefined,
    upsertPosts: (_userId, siteId) => savedSites.push(siteId)
  };

  const result = await refreshSubscriptionFeedForUser('user', undefined, deps);

  assert.deepEqual(savedSites, ['healthy']);
  assert.deepEqual(result.errors.map((entry) => entry.siteId), ['broken']);
});
