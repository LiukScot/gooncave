import '../../../test/helpers/setupEnv';

import assert from 'node:assert/strict';

import { test } from 'bun:test';

import type { RemotePost } from '../../lib/booruEngines/types';

import { authRepo } from './authRepo';
import { booruSitesRepo } from './booruSitesRepo';
import { subscriptionFeedRepo } from './subscriptionFeedRepo';

const remotePost = (remoteId: string, createdAt: string): RemotePost => ({
  remoteId,
  previewUrl: null,
  sampleUrl: null,
  fileUrl: null,
  width: null,
  height: null,
  score: null,
  rating: null,
  md5: null,
  createdAt,
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

test('subscription feed persists a globally chronological deduplicated stream', async () => {
  const user = await authRepo.createUser({
    username: 'feed_repo',
    passwordHash: 'hash',
    libraryRoot: '/tmp/feed-repo'
  });
  const firstSite = await booruSitesRepo.insertBooruSite(
    { name: 'First', engine: 'e621', baseUrl: 'https://first.test' },
    user.id
  );
  const secondSite = await booruSitesRepo.insertBooruSite(
    { name: 'Second', engine: 'danbooru', baseUrl: 'https://second.test' },
    user.id
  );

  subscriptionFeedRepo.upsertPosts(user.id, firstSite.id, [
    remotePost('older', '2026-01-01T00:00:00.000Z'),
    remotePost('newer', '2026-01-03T00:00:00.000Z')
  ]);
  subscriptionFeedRepo.upsertPosts(user.id, secondSite.id, [
    remotePost('middle', '2026-01-02T00:00:00.000Z')
  ]);
  subscriptionFeedRepo.upsertPosts(user.id, firstSite.id, [
    remotePost('newer', '2026-01-03T00:00:00.000Z')
  ]);

  const firstPage = subscriptionFeedRepo.listPosts(user.id, {
    limit: 2
  });
  subscriptionFeedRepo.upsertPosts(user.id, secondSite.id, [
    remotePost('new-head', '2026-01-04T00:00:00.000Z')
  ]);
  const secondPage = subscriptionFeedRepo.listPosts(user.id, {
    cursor: firstPage.nextCursor ?? undefined,
    limit: 2
  });

  assert.deepEqual(
    firstPage.items.map(({ post }) => post.remoteId),
    ['newer', 'middle']
  );
  assert.equal(firstPage.hasMore, true);
  assert.deepEqual(
    secondPage.items.map(({ post }) => post.remoteId),
    ['older']
  );
  assert.equal(secondPage.hasMore, false);
});

test('subscription feed sync state advances independently for each site', async () => {
  const user = await authRepo.createUser({
    username: 'feed_state',
    passwordHash: 'hash',
    libraryRoot: '/tmp/feed-state'
  });
  const site = await booruSitesRepo.insertBooruSite(
    { name: 'Source', engine: 'e621', baseUrl: 'https://source.test' },
    user.id
  );

  subscriptionFeedRepo.saveState(user.id, site.id, {
    nextTagIndex: 7,
    headTagIndex: 3,
    searchPage: 4,
    searchPageHadPosts: true,
    searchExhausted: false,
    feedCursor: 'next',
    feedHeadCursor: 'newer',
    feedExhausted: false,
    lastError: null
  });

  assert.deepEqual(subscriptionFeedRepo.getState(user.id, site.id), {
    nextTagIndex: 7,
    headTagIndex: 3,
    searchPage: 4,
    searchPageHadPosts: true,
    searchExhausted: false,
    feedCursor: 'next',
    feedHeadCursor: 'newer',
    feedExhausted: false,
    updatedAt: subscriptionFeedRepo.getState(user.id, site.id).updatedAt,
    lastError: null
  });
});

test('clearing a feed rejects writes from an older process generation', async () => {
  const user = await authRepo.createUser({
    username: 'feed_generation',
    passwordHash: 'hash',
    libraryRoot: '/tmp/feed-generation'
  });
  const site = await booruSitesRepo.insertBooruSite(
    { name: 'Source', engine: 'e621', baseUrl: 'https://source.test' },
    user.id
  );
  const staleGeneration = subscriptionFeedRepo.getGeneration(user.id);

  subscriptionFeedRepo.clearForUser(user.id);
  const written = subscriptionFeedRepo.upsertPosts(
    user.id,
    site.id,
    [remotePost('stale', '2026-01-01T00:00:00.000Z')],
    staleGeneration
  );

  assert.equal(written, false);
  assert.deepEqual(subscriptionFeedRepo.listPosts(user.id, { limit: 10 }).items, []);
});

test('favorite overrides survive feed refreshes', async () => {
  const user = await authRepo.createUser({
    username: 'feed_favorite_override',
    passwordHash: 'hash',
    libraryRoot: '/tmp/feed-favorite-override'
  });
  const site = await booruSitesRepo.insertBooruSite(
    { name: 'Source', engine: 'e621', baseUrl: 'https://source.test' },
    user.id
  );
  const stalePost = { ...remotePost('post', '2026-01-01T00:00:00.000Z'), favorited: true };
  subscriptionFeedRepo.upsertPosts(user.id, site.id, [stalePost]);
  subscriptionFeedRepo.setFavoriteOverride(user.id, site.id, 'post', false);
  subscriptionFeedRepo.upsertPosts(user.id, site.id, [stalePost]);

  assert.equal(
    subscriptionFeedRepo.listPosts(user.id, { limit: 1 }).items[0]
      .favoritedOverride,
    false
  );
});
