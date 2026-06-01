import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setupFetchMock } from '../../../test/helpers/fetchMock';
import type { BooruSiteRecord } from '../../db/types';

import { gelbooruEngine } from './gelbooru';

const baseSite = (
  overrides: Partial<BooruSiteRecord> = {}
): BooruSiteRecord => ({
  id: 'site-1',
  userId: 'user-1',
  name: 'TestBooru',
  engine: 'gelbooru',
  baseUrl: 'https://gelbooru.com',
  username: '42',
  apiKey: 'testkey',
  isPreset: false,
  presetKey: null,
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides
});

const favHtmlPage = (postIds: number[]): string =>
  postIds
    .map((id) => `<a href="index.php?page=post&amp;s=view&amp;id=${id}">x</a>`)
    .join('\n');

const postJson = (id: number, fileUrl: string | null) =>
  JSON.stringify([{ id, file_url: fileUrl, sample_url: null, tags: 't' }]);

test('fetchFavorites throws when credentials missing', async () => {
  const site = baseSite({ username: null, apiKey: null });
  await assert.rejects(
    () => gelbooruEngine.fetchFavorites!(site),
    /credentials missing/
  );
});

test('fetchFavorites scrapes HTML and resolves each post via API', async (t) => {
  const fm = setupFetchMock(t);
  // First call: HTML favorites page (returns 2 post ids)
  fm.intercept((url) => url.includes('page=favorites'), {
    status: 200,
    body: favHtmlPage([1, 2])
  });
  // Empty second HTML page (signals end of pagination)
  fm.intercept((url) => url.includes('page=favorites'), {
    status: 200,
    body: ''
  });
  // API calls for each post id
  fm.intercept((url) => url.includes('s=post') && url.includes('id=1'), {
    status: 200,
    body: postJson(1, 'https://img.gelbooru.com/1.jpg')
  });
  fm.intercept((url) => url.includes('s=post') && url.includes('id=2'), {
    status: 200,
    body: postJson(2, 'https://img.gelbooru.com/2.jpg')
  });

  const result = await gelbooruEngine.fetchFavorites!(baseSite());
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].remoteId, '1');
  assert.equal(result.items[0].fileUrl, 'https://img.gelbooru.com/1.jpg');
  assert.match(result.items[0].sourceUrl, /page=post&s=view&id=1/);
  assert.equal(result.items[1].remoteId, '2');
});

test('fetchFavorites returns empty list when HTML page has no posts', async (t) => {
  const fm = setupFetchMock(t);
  fm.intercept((url) => url.includes('page=favorites'), {
    status: 200,
    body: '<html><body>no favorites</body></html>'
  });

  const result = await gelbooruEngine.fetchFavorites!(baseSite());
  assert.equal(result.items.length, 0);
});

test('fetchFavorites throws when HTML page returns non-200', async (t) => {
  const fm = setupFetchMock(t);
  fm.intercept((url) => url.includes('page=favorites'), {
    status: 500,
    body: 'server error'
  });

  await assert.rejects(
    () => gelbooruEngine.fetchFavorites!(baseSite()),
    /favorites page failed.*500/
  );
});

test('fetchFavorites throws on JSON-string auth error from post API', async (t) => {
  const fm = setupFetchMock(t);
  fm.intercept((url) => url.includes('page=favorites'), {
    status: 200,
    body: favHtmlPage([1])
  });
  fm.intercept((url) => url.includes('s=post'), {
    status: 200,
    body: JSON.stringify('Missing authentication. Go to api.rule34.xxx')
  });

  await assert.rejects(
    () => gelbooruEngine.fetchFavorites!(baseSite()),
    /favorites failed.*Missing authentication/
  );
});

test('fetchFavorites skips a post when its API call fails (non-200)', async (t) => {
  const fm = setupFetchMock(t);
  fm.intercept((url) => url.includes('page=favorites'), {
    status: 200,
    body: favHtmlPage([1, 2])
  });
  fm.intercept((url) => url.includes('s=post') && url.includes('id=1'), {
    status: 404,
    body: 'not found'
  });
  fm.intercept((url) => url.includes('s=post') && url.includes('id=2'), {
    status: 200,
    body: postJson(2, 'https://img.gelbooru.com/2.jpg')
  });

  const result = await gelbooruEngine.fetchFavorites!(baseSite());
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].remoteId, '2');
});

test('fetchFavorites scrapes HTML page with site.username (user_id) in URL', async (t) => {
  const fm = setupFetchMock(t);
  let capturedUrl = '';
  fm.intercept(
    (url) => {
      if (url.includes('page=favorites')) {
        capturedUrl = url;
        return true;
      }
      return false;
    },
    { status: 200, body: '' }
  );

  await gelbooruEngine.fetchFavorites!(baseSite({ username: '4141023' }));
  assert.match(capturedUrl, /page=favorites/);
  assert.match(capturedUrl, /id=4141023/);
});

test('fetchFavorites aborts when signal fires before loop', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      gelbooruEngine.fetchFavorites!(baseSite(), { signal: controller.signal }),
    /aborted/i
  );
});

test('unfavorite rejects a redirect to the favorites view', async (t) => {
  const fm = setupFetchMock(t);
  fm.intercept(
    (url) =>
      url.includes('page=favorites') &&
      url.includes('s=delete') &&
      url.includes('id=123'),
    {
      status: 302,
      body: '',
      headers: { location: '/index.php?page=favorites&s=view&id=' }
    }
  );

  await assert.rejects(
    () => gelbooruEngine.unfavorite!(baseSite(), '123'),
    /unfavorite redirected/
  );
});
