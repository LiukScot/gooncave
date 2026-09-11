import './helpers/setupEnv';

import assert from 'node:assert/strict';

import { afterAll, beforeAll, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';

import { booruSitesRepo } from '../src/db/repos/booruSitesRepo';
import { subscriptionFeedRepo } from '../src/db/repos/subscriptionFeedRepo';
import type { RemotePost } from '../src/lib/booruEngines/types';

import { buildTestApp, seedUser, sessionCookieFor } from './helpers/testApp';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

const post = (remoteId: string, createdAt: string): RemotePost => ({
  remoteId,
  previewUrl: `https://media.test/${remoteId}.jpg`,
  sampleUrl: null,
  fileUrl: `https://media.test/${remoteId}.png`,
  width: 100,
  height: 100,
  score: 0,
  rating: 's',
  md5: null,
  createdAt,
  tags: [],
  favCount: 0,
  uploader: null,
  fileExt: 'png',
  fileSize: null,
  favorited: false,
  voted: null,
  parentId: null,
  hasChildren: false,
  poolIds: []
});

test('subscription endpoint pages one mixed chronological local feed', async () => {
  const seeded = await seedUser({ username: 'indexed_subscription_feed' });
  const session = await sessionCookieFor(seeded.user.id);
  const cookie = `${session.name}=${session.value}`;
  const firstSite = await booruSitesRepo.insertBooruSite(
    { name: 'First', engine: 'e621', baseUrl: 'https://first.test' },
    seeded.user.id
  );
  const secondSite = await booruSitesRepo.insertBooruSite(
    { name: 'Second', engine: 'danbooru', baseUrl: 'https://second.test' },
    seeded.user.id
  );
  subscriptionFeedRepo.upsertPosts(seeded.user.id, firstSite.id, [
    post('first-new', '2026-01-03T00:00:00.000Z'),
    post('first-old', '2026-01-01T00:00:00.000Z')
  ]);
  subscriptionFeedRepo.setFavoriteOverride(
    seeded.user.id,
    firstSite.id,
    'first-new',
    false
  );
  subscriptionFeedRepo.upsertPosts(seeded.user.id, secondSite.id, [
    post('second-middle', '2026-01-02T00:00:00.000Z')
  ]);

  const firstPage = await app.inject({
    method: 'GET',
    url: '/explore/subscriptions?limit=2',
    headers: { cookie }
  });
  const cursor = firstPage.json().nextCursor as string;
  const secondPage = await app.inject({
    method: 'GET',
    url: `/explore/subscriptions?cursor=${encodeURIComponent(cursor)}&limit=2`,
    headers: { cookie }
  });

  assert.equal(firstPage.statusCode, 200, firstPage.body);
  assert.deepEqual(
    firstPage.json().posts.map((entry: { remoteId: string }) => entry.remoteId),
    ['first-new', 'second-middle']
  );
  assert.equal(firstPage.json().posts[0].favorited, false);
  assert.equal(firstPage.json().hasMore, true);
  assert.deepEqual(
    secondPage.json().posts.map((entry: { remoteId: string }) => entry.remoteId),
    ['first-old']
  );
  assert.equal(secondPage.json().hasMore, false);

  const update = await app.inject({
    method: 'PUT',
    url: '/settings/subscriptions/tags',
    headers: { cookie },
    payload: { tags: ['different_subject'] }
  });
  const cleared = await app.inject({
    method: 'GET',
    url: '/explore/subscriptions',
    headers: { cookie }
  });

  assert.equal(update.statusCode, 200, update.body);
  assert.deepEqual(cleared.json().posts, []);
});

test('a tag change keeps the posts of sites with a feed of their own', async () => {
  const seeded = await seedUser({ username: 'tag_reset_keeps_feed_sites' });
  const session = await sessionCookieFor(seeded.user.id);
  const cookie = `${session.name}=${session.value}`;
  const searchSite = await booruSitesRepo.insertBooruSite(
    { name: 'Search', engine: 'e621', baseUrl: 'https://search.test' },
    seeded.user.id
  );
  const feedSite = await booruSitesRepo.insertBooruSite(
    {
      name: 'Watchlist',
      engine: 'furaffinity',
      baseUrl: 'https://www.furaffinity.net'
    },
    seeded.user.id
  );
  subscriptionFeedRepo.upsertPosts(seeded.user.id, searchSite.id, [
    post('from-search', '2026-01-02T00:00:00.000Z')
  ]);
  subscriptionFeedRepo.upsertPosts(seeded.user.id, feedSite.id, [
    post('from-watchlist', '2026-01-01T00:00:00.000Z')
  ]);

  const update = await app.inject({
    method: 'PUT',
    url: '/settings/subscriptions/tags',
    headers: { cookie },
    payload: { tags: ['new_subject'] }
  });
  const feed = await app.inject({
    method: 'GET',
    url: '/explore/subscriptions',
    headers: { cookie }
  });

  assert.equal(update.statusCode, 200, update.body);
  assert.deepEqual(
    feed.json().posts.map((entry: { remoteId: string }) => entry.remoteId),
    ['from-watchlist']
  );
});
