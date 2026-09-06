// The parent/child group assembly, over a canned booru. No network, and an
// empty throwaway database: the group is looked up against the library to see
// which of its posts are already saved.
import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';

import { afterEach, test } from 'bun:test';

import { disarmFetchMock, setupFetchMock } from '../../test/helpers/fetchMock';
import type { BooruSiteRecord } from '../db/types';

import { listRelatedPosts } from './postRelations';

afterEach(disarmFetchMock);

const site = (
  engine: 'danbooru' | 'shimmie' | 'gelbooru' = 'danbooru'
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

const postJson = (id: number, parentId: number | null, hasChildren = false) => ({
  id,
  preview_file_url: `https://booru.example/thumb/${id}.jpg`,
  image_width: 100,
  image_height: 200,
  parent_id: parentId,
  has_children: hasChildren
});

test('listRelatedPosts puts the parent first and marks the open post', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('parent%3A1'), {
    status: 200,
    body: JSON.stringify([postJson(1, null, true), postJson(2, 1)])
  });

  const posts = await listRelatedPosts(
    site(),
    '2',
    { parentId: '1', hasChildren: false, poolIds: null },
    'user-1'
  );

  assert.deepEqual(
    posts.map((post) => [post.remoteId, post.isParent, post.isCurrent]),
    [
      ['1', true, false],
      ['2', false, true]
    ]
  );
  assert.equal(posts[0].sourceUrl, 'https://booru.example/posts/1');
  // Nothing in this library yet, so no member points at a local file.
  assert.deepEqual(
    posts.map((post) => post.localFileId),
    [null, null]
  );
});

test('listRelatedPosts reads the parent again when the group omits it', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('parent%3A7'), {
    status: 200,
    body: JSON.stringify([postJson(8, 7), postJson(9, 7)])
  });
  fm.intercept((url) => url.includes('id%3A7'), {
    status: 200,
    body: JSON.stringify([postJson(7, null, true)])
  });

  const posts = await listRelatedPosts(
    site(),
    '7',
    { parentId: null, hasChildren: true, poolIds: null },
    'user-1'
  );

  assert.deepEqual(
    posts.map((post) => post.remoteId),
    ['7', '8', '9']
  );
});

test('listRelatedPosts asks nothing for a post with no relatives', async () => {
  setupFetchMock();
  const posts = await listRelatedPosts(
    site(),
    '3',
    { parentId: null, hasChildren: false, poolIds: null },
    'user-1'
  );
  assert.deepEqual(posts, []);
});

test('listRelatedPosts is empty on an engine without parent posts', async () => {
  setupFetchMock();
  const posts = await listRelatedPosts(
    site('shimmie'),
    '3',
    { parentId: '1', hasChildren: false, poolIds: null },
    'user-1'
  );
  assert.deepEqual(posts, []);
});

test('listRelatedPosts drops a group the booru answered alone', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('parent%3A5'), {
    status: 200,
    body: JSON.stringify([postJson(5, null, true)])
  });

  const posts = await listRelatedPosts(
    site(),
    '5',
    { parentId: null, hasChildren: true, poolIds: null },
    'user-1'
  );
  assert.deepEqual(posts, []);
});

test('listRelatedPosts probes a booru that never reports children', async () => {
  const fm = setupFetchMock();
  // rule34 and friends send parent_id and no children flag, so a parent post
  // arrives looking childless. The group is found by asking anyway.
  fm.intercept((url) => url.includes('parent%3A4'), {
    status: 200,
    body: JSON.stringify({
      post: [
        { id: 4, parent_id: 0, preview_url: 't/4.jpg', width: 1, height: 1 },
        { id: 5, parent_id: 4, preview_url: 't/5.jpg', width: 1, height: 1 }
      ]
    })
  });

  const posts = await listRelatedPosts(
    site('gelbooru'),
    '4',
    { parentId: null, hasChildren: false, poolIds: null },
    'user-1'
  );

  assert.deepEqual(
    posts.map((post) => [post.remoteId, post.isParent, post.isCurrent]),
    [
      ['4', true, true],
      ['5', false, false]
    ]
  );
});

test('listRelatedPosts serves the next reader from the cached group', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('parent%3A11'), {
    status: 200,
    body: JSON.stringify([postJson(11, null, true), postJson(12, 11)])
  });
  const first = await listRelatedPosts(
    site(),
    '11',
    { parentId: null, hasChildren: true, poolIds: null },
    'user-1'
  );
  assert.equal(first.length, 2);

  // No routes armed: a second read of the same group would throw rather than
  // be answered, so what comes back can only be the cached listing.
  setupFetchMock();
  const sibling = await listRelatedPosts(
    site(),
    '12',
    { parentId: '11', hasChildren: false, poolIds: null },
    'user-1'
  );
  assert.deepEqual(
    sibling.map((post) => [post.remoteId, post.isCurrent]),
    [
      ['11', false],
      ['12', true]
    ]
  );
});
