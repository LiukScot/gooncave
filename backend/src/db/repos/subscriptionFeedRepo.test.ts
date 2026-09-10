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
    feedCursor: 'next',
    feedExhausted: false,
    lastError: null
  });

  assert.deepEqual(subscriptionFeedRepo.getState(user.id, site.id), {
    nextTagIndex: 7,
    feedCursor: 'next',
    feedExhausted: false,
    updatedAt: subscriptionFeedRepo.getState(user.id, site.id).updatedAt,
    lastError: null
  });
});
