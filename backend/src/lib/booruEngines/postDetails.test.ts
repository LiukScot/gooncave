// The point of fetchPostDetails is that a post's own page is read once for
// both its tags and its relations. These pin that: a single armed route, so a
// second request would fail rather than pass unnoticed.
import assert from 'node:assert/strict';

import { afterEach, test } from 'bun:test';

import { disarmFetchMock, setupFetchMock } from '../../../test/helpers/fetchMock';
import type { BooruSiteRecord } from '../../db/types';

import { danbooruEngine } from './danbooru';
import { e621Engine } from './e621';

afterEach(disarmFetchMock);

const site = (engine: 'e621' | 'danbooru'): BooruSiteRecord => ({
  id: 'site-1',
  userId: 'user-1',
  name: 'test',
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

test('e621 answers tags, parent, children and pools from one read', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('/posts/7.json'), {
    status: 200,
    body: JSON.stringify({
      post: {
        id: 7,
        tags: { general: ['alpha'], artist: ['someone'] },
        relationships: { parent_id: 4, has_children: true },
        pools: [90, 91]
      }
    })
  });

  const details = await e621Engine.fetchPostDetails!(site('e621'), '7');

  assert.deepEqual(
    details?.tags.map((tag) => [tag.tag, tag.category]),
    [
      ['alpha', 'general'],
      ['someone', 'artist']
    ]
  );
  assert.deepEqual(details?.relations, {
    parentId: '4',
    hasChildren: true,
    poolIds: ['90', '91']
  });
});

test('danbooru answers tags and relations from one read, pools unknown', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('/posts/7.json'), {
    status: 200,
    body: JSON.stringify({
      id: 7,
      tag_string_general: 'alpha',
      parent_id: 4,
      has_children: false
    })
  });

  const details = await danbooruEngine.fetchPostDetails!(site('danbooru'), '7');

  assert.deepEqual(
    details?.tags.map((tag) => tag.tag),
    ['alpha']
  );
  // Null, not []: a danbooru post never lists its pools, and saying "none"
  // would stop the pool search that does know from ever running.
  assert.deepEqual(details?.relations, {
    parentId: '4',
    hasChildren: false,
    poolIds: null
  });
});

test('a post that cannot be read is null rather than empty relations', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('/posts/7.json'), {
    status: 404,
    body: 'not found'
  });

  assert.equal(await e621Engine.fetchPostDetails!(site('e621'), '7'), null);
});
