import assert from 'node:assert/strict';

import { afterEach, test } from 'bun:test';

import {
  disarmFetchMock,
  setupFetchMock
} from '../../../test/helpers/fetchMock';
import type { BooruSiteRecord } from '../../db/types';

import { gelbooruEngine } from './gelbooru';

afterEach(disarmFetchMock);

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
  sessionCookie: null,
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

test('fetchFavorites scrapes HTML and resolves each post via API', async () => {
  const fm = setupFetchMock();
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

test('fetchFavorites returns empty list when HTML page has no posts', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('page=favorites'), {
    status: 200,
    body: '<html><body>no favorites</body></html>'
  });

  const result = await gelbooruEngine.fetchFavorites!(baseSite());
  assert.equal(result.items.length, 0);
});

test('fetchFavorites throws when HTML page returns non-200', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('page=favorites'), {
    status: 500,
    body: 'server error'
  });

  await assert.rejects(
    () => gelbooruEngine.fetchFavorites!(baseSite()),
    /favorites page failed.*500/
  );
});

test('fetchFavorites throws on JSON-string auth error from post API', async () => {
  const fm = setupFetchMock();
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

test('fetchFavorites skips a post when its API call fails (non-200)', async () => {
  const fm = setupFetchMock();
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

test('fetchFavorites scrapes HTML page with site.username (user_id) in URL', async () => {
  const fm = setupFetchMock();
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

test('unfavorite returns once the favorite is gone after the delete', async () => {
  const fm = setupFetchMock();
  // Delete endpoint redirects back to favorites — proves nothing on its own.
  fm.intercept((url) => url.includes('s=delete') && url.includes('id=123'), {
    status: 302,
    body: '',
    headers: { location: '/index.php?page=favorites&s=view&id=' }
  });
  // Verification re-fetch: favorites page no longer lists 123.
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: favHtmlPage([999])
  });

  await gelbooruEngine.unfavorite!(baseSite(), '123');
});

test('unfavorite returns on 404 without re-fetching (already absent)', async () => {
  const fm = setupFetchMock();
  // Only the delete is armed; if verification ran it would hit no route and
  // throw, so a clean resolve proves we short-circuit on 404.
  fm.intercept((url) => url.includes('s=delete'), {
    status: 404,
    body: 'not found'
  });

  await gelbooruEngine.unfavorite!(baseSite(), '123');
});

test('unfavorite throws on a hard failure response', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('s=delete'), {
    status: 500,
    body: 'boom'
  });

  await assert.rejects(
    () => gelbooruEngine.unfavorite!(baseSite(), '123'),
    /unfavorite failed.*500/
  );
});

test('unfavorite flags an expired cookie when the post is still favorited', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('s=delete'), {
    status: 302,
    body: '',
    headers: { location: '/index.php?page=favorites' }
  });
  // Verification still finds 123 → delete did not take.
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: favHtmlPage([123])
  });

  await assert.rejects(
    () =>
      gelbooruEngine.unfavorite!(
        baseSite({ sessionCookie: 'sess=abc' }),
        '123'
      ),
    /not confirmed.*expired or invalid/
  );
});

test('unfavorite asks for a cookie when none is set and delete did not take', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('s=delete'), {
    status: 302,
    body: '',
    headers: { location: '/index.php?page=favorites' }
  });
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: favHtmlPage([123])
  });

  await assert.rejects(
    () => gelbooruEngine.unfavorite!(baseSite({ sessionCookie: null }), '123'),
    /add a session cookie/
  );
});

test('unfavorite sends the session cookie and never leaks it in errors', async () => {
  const fm = setupFetchMock();
  const secret = 'user_id=42; pass_hash=supersecret-value';
  let sentCookie: string | undefined;
  fm.intercept(
    (url, init) => {
      if (!url.includes('s=delete')) return false;
      sentCookie = (init?.headers as Record<string, string> | undefined)
        ?.Cookie;
      return true;
    },
    {
      status: 302,
      body: '',
      headers: { location: '/index.php?page=favorites' }
    }
  );
  // Still favorited so it throws — lets us assert the error omits the cookie.
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: favHtmlPage([123])
  });

  let message = '';
  try {
    await gelbooruEngine.unfavorite!(
      baseSite({ sessionCookie: secret }),
      '123'
    );
  } catch (err) {
    message = (err as Error).message;
  }

  assert.equal(sentCookie, secret); // cookie actually reached the delete request
  assert.ok(message.length > 0); // it did throw (not a silent success)
  assert.ok(!message.includes('supersecret-value')); // but never leaked the value
});

test('checkSessionCookie reports ok when the logout link is present', async () => {
  const fm = setupFetchMock();
  // Rule34's logout link — the code=01 is the logged-in marker. Entity-encoded
  // ampersand, as it appears in real HTML.
  fm.intercept((url) => url.includes('page=account'), {
    status: 200,
    body: '<a href="index.php?page=account&amp;s=login&amp;code=01">Logout</a>'
  });

  const result = await gelbooruEngine.checkSessionCookie!(
    baseSite({ sessionCookie: 'user_id=42; pass_hash=abc' })
  );
  assert.equal(result.ok, true);
});

test('checkSessionCookie flags a cookie that redirects away from the account page', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('page=account'), {
    status: 302,
    body: '',
    headers: { location: '/index.php?page=account&s=login' }
  });

  const result = await gelbooruEngine.checkSessionCookie!(
    baseSite({ sessionCookie: 'user_id=42; pass_hash=stale' })
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not authenticated/);
});

test('checkSessionCookie flags a page without the logout link', async () => {
  const fm = setupFetchMock();
  // The plain login form (s=login, no code=01) — i.e. not logged in.
  fm.intercept((url) => url.includes('page=account'), {
    status: 200,
    body: '<form action="index.php?page=account&s=login"><input name="pass" type="password"></form>'
  });

  const result = await gelbooruEngine.checkSessionCookie!(
    baseSite({ sessionCookie: 'user_id=42; pass_hash=wrong' })
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not authenticated/);
});

test('checkSessionCookie sends the cookie but never returns its value', async () => {
  const fm = setupFetchMock();
  const secret = 'user_id=42; pass_hash=supersecret-value';
  let sentCookie: string | undefined;
  fm.intercept(
    (url, init) => {
      if (!url.includes('page=account')) return false;
      sentCookie = (init?.headers as Record<string, string> | undefined)
        ?.Cookie;
      return true;
    },
    { status: 200, body: '<form><input name="pass" type="password"></form>' }
  );

  const result = await gelbooruEngine.checkSessionCookie!(
    baseSite({ sessionCookie: secret })
  );
  assert.equal(sentCookie, secret); // cookie reached the request
  assert.equal(result.ok, false);
  assert.ok(!(result.error ?? '').includes('supersecret-value')); // never leaked
});

test('checkSessionCookie returns a failure (not a throw) on a transport error', async () => {
  // No account route armed → the mocked fetch rejects, simulating a network
  // error. The /test route must stay a 200 status object, never a 500.
  setupFetchMock();
  const result = await gelbooruEngine.checkSessionCookie!(
    baseSite({ sessionCookie: 'user_id=42; pass_hash=secret-value' })
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /cookie check failed/);
  assert.ok(!(result.error ?? '').includes('secret-value')); // never leaked
});
