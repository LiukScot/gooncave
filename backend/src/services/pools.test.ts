// Pool navigation over a canned booru: no network, empty throwaway database.
import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';

import { afterEach, test } from 'bun:test';

import { disarmFetchMock, setupFetchMock } from '../../test/helpers/fetchMock';
import type { BooruSiteRecord } from '../db/types';

import { describePostPools, readPoolPage } from './pools';

afterEach(disarmFetchMock);

const site = (
  engine: 'danbooru' | 'gelbooru' = 'danbooru'
): BooruSiteRecord => ({
  id: 'site-1',
  userId: 'user-1',
  name: 'TestBooru',
  engine,
  baseUrl: 'https://booru.example',
  username: 'user',
  apiKey: 'key',
  sessionCookie: null,
  isPreset: false,
  presetKey: null,
  enabled: true,
  siteAutoSyncMidnight: false,
  siteReverseSyncEnabled: false,
  siteAutoFavEnabled: false,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
});

const poolJson = (id: number, postIds: number[]) =>
  JSON.stringify({
    id,
    name: 'A_Long_Story',
    post_ids: postIds,
    post_count: postIds.length
  });

const postJson = (id: number) => ({
  id,
  preview_file_url: `https://booru.example/thumb/${id}.jpg`,
  image_width: 100,
  image_height: 200,
  parent_id: null,
  has_children: false
});

test('describePostPools reports the position and both neighbours', async () => {
  const fm = setupFetchMock();
  // danbooru's pool search returns the pools whole, so no `/pools/90.json`
  // is mocked: a second read would fail the test.
  fm.intercept((url) => url.includes('post_ids_include_any'), {
    status: 200,
    body: `[${poolJson(90, [11, 12, 13])}]`
  });

  const pools = await describePostPools(site(), '12', null);

  assert.equal(pools.length, 1);
  assert.equal(pools[0].name, 'A Long Story');
  assert.equal(pools[0].position, 2);
  assert.equal(pools[0].postCount, 3);
  assert.equal(pools[0].prevId, '11');
  assert.equal(pools[0].nextId, '13');
});

test('describePostPools leaves the ends without a neighbour', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('/pools/91.json'), {
    status: 200,
    body: poolJson(91, [21, 22])
  });

  // The caller already knew the pool, so no lookup by post is made.
  const pools = await describePostPools(site(), '21', ['91']);

  assert.equal(pools[0].position, 1);
  assert.equal(pools[0].prevId, null);
  assert.equal(pools[0].nextId, '22');
});

test('describePostPools skips a pool that no longer lists the post', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('/pools/92.json'), {
    status: 200,
    body: poolJson(92, [31, 32])
  });

  const pools = await describePostPools(site(), '99', ['92']);
  assert.deepEqual(pools, []);
});

test('describePostPools asks nothing of an engine without pools', async () => {
  setupFetchMock();
  const pools = await describePostPools(site('gelbooru'), '1', null);
  assert.deepEqual(pools, []);
});

test('readPoolPage numbers the pages by their place in the pool', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('/pools/93.json'), {
    status: 200,
    body: poolJson(93, [41, 42, 43])
  });
  // The booru answers an id list newest first; the pool's order wins.
  fm.intercept((url) => url.includes('id%3A41%2C42%2C43'), {
    status: 200,
    body: JSON.stringify([postJson(43), postJson(41), postJson(42)])
  });

  const page = await readPoolPage(site(), '93', 1, 'user-1');

  assert.equal(page?.name, 'A Long Story');
  assert.deepEqual(
    page?.posts.map((post) => [post.remoteId, post.position]),
    [
      ['41', 1],
      ['42', 2],
      ['43', 3]
    ]
  );
});

test('describePostPools reads two pools side by side, and no posts', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('/pools/94.json'), {
    status: 200,
    body: poolJson(94, [51, 52])
  });
  fm.intercept((url) => url.includes('/pools/95.json'), {
    status: 200,
    body: poolJson(95, [52, 53])
  });

  // Two pool reads and nothing else: fetching the neighbouring posts here is
  // what made the block wait on four requests before it could render.
  const pools = await describePostPools(site(), '52', ['94', '95']);

  assert.deepEqual(
    pools.map((pool) => [pool.poolId, pool.position, pool.prevId, pool.nextId]),
    [
      ['94', 2, '51', null],
      ['95', 1, null, '53']
    ]
  );
});
