import assert from 'node:assert/strict';

import { afterEach, test } from 'bun:test';

import {
  disarmFetchMock,
  setupFetchMock
} from '../../../test/helpers/fetchMock';
import type { BooruSiteRecord } from '../../db/types';

import { gelbooruEngine, parsePostPageTags } from './gelbooru';

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

const searchOptions = {
  tags: ['subject'],
  sort: 'new' as const,
  window: 'day' as const,
  date: '2026-09-13',
  page: 1,
  limit: 40
};

test('searchPosts retries a truncated JSON response once', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('page=dapi'), {
    status: 200,
    body: '[{"id":1'
  });
  fm.intercept((url) => url.includes('page=dapi'), {
    status: 200,
    body: postJson(1, 'https://img.gelbooru.com/1.jpg')
  });

  const result = await gelbooruEngine.searchPosts!(baseSite(), searchOptions);

  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].remoteId, '1');
});

test('searchPosts treats a repeated empty success response as no results', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('page=dapi'), {
    status: 200,
    body: ''
  });
  fm.intercept((url) => url.includes('page=dapi'), {
    status: 200,
    body: ''
  });

  const result = await gelbooruEngine.searchPosts!(baseSite(), searchOptions);

  assert.deepEqual(result.posts, []);
});

test('searchPosts explains repeated invalid JSON without leaking its body', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('page=dapi'), {
    status: 200,
    body: '[{"secret":"first-response"'
  });
  fm.intercept((url) => url.includes('page=dapi'), {
    status: 200,
    body: '[{"secret":"second-response"'
  });

  let message = '';
  try {
    await gelbooruEngine.searchPosts!(baseSite(), searchOptions);
  } catch (error) {
    message = (error as Error).message;
  }

  assert.match(message, /search returned invalid JSON twice/);
  assert.ok(!message.includes('secret'));
});

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

test('fetchFavorites skips the post lookup for a favorite already downloaded', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('page=favorites'), {
    status: 200,
    body: favHtmlPage([1, 2])
  });
  fm.intercept((url) => url.includes('page=favorites'), {
    status: 200,
    body: ''
  });
  // No route for post 1: a lookup for it fails the test.
  fm.intercept((url) => url.includes('s=post') && url.includes('id=2'), {
    status: 200,
    body: postJson(2, 'https://img.gelbooru.com/2.jpg')
  });

  const result = await gelbooruEngine.fetchFavorites!(baseSite(), {
    alreadyDownloaded: new Set(['1'])
  });
  assert.deepEqual(
    result.items.map((item) => [item.remoteId, item.fileUrl]),
    [
      ['1', null],
      ['2', 'https://img.gelbooru.com/2.jpg']
    ]
  );
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

test('favorite adds through the endpoint the site itself calls', async () => {
  const fm = setupFetchMock();
  let capturedUrl = '';
  fm.intercept(
    (url) => {
      if (url.includes('addfav.php')) {
        capturedUrl = url;
        return true;
      }
      return false;
    },
    { status: 200, body: '3' }
  );
  // Verification re-fetch: the post is now listed.
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: favHtmlPage([123])
  });

  await gelbooruEngine.favorite!(baseSite({ sessionCookie: 'x' }), '123');
  assert.match(capturedUrl, /public\/addfav\.php\?id=123/);
});

test('favorite falls back to the legacy action on a fork without addfav', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('addfav.php'), {
    status: 404,
    body: 'not found'
  });
  let legacyUrl = '';
  fm.intercept(
    (url) => {
      if (url.includes('s=add')) {
        legacyUrl = url;
        return true;
      }
      return false;
    },
    { status: 200, body: '' }
  );
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: favHtmlPage([123])
  });

  await gelbooruEngine.favorite!(baseSite({ sessionCookie: 'x' }), '123');
  assert.match(legacyUrl, /page=favorites&s=add&id=123/);
});

test('favorite retries a transient add failure', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('addfav.php'), {
    status: 500,
    body: 'Internal Server Error'
  });
  fm.intercept((url) => url.includes('addfav.php'), {
    status: 200,
    body: '3'
  });
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: favHtmlPage([123])
  });

  await gelbooruEngine.favorite!(baseSite({ sessionCookie: 'x' }), '123');
});

test('favorite does not retry a permanent add failure', async () => {
  const fm = setupFetchMock();
  let requests = 0;
  fm.intercept((url) => url.includes('addfav.php'), {
    status: 403,
    body: 'forbidden',
    persist: true,
    onStart: () => {
      requests += 1;
    }
  });

  await assert.rejects(
    () => gelbooruEngine.favorite!(baseSite({ sessionCookie: 'x' }), '123'),
    /favorite failed \(403\)/
  );
  assert.equal(requests, 1);
});

test('favorite waits for delayed remote visibility', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('addfav.php'), {
    status: 200,
    body: '3'
  });
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: favHtmlPage([999])
  });
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: favHtmlPage([123])
  });

  await gelbooruEngine.favorite!(baseSite({ sessionCookie: 'x' }), '123');
});

test('favorite reports a cookie problem when the post never appears', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('addfav.php'), { status: 200, body: '' });
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: favHtmlPage([999]),
    persist: true
  });

  await assert.rejects(
    () => gelbooruEngine.favorite!(baseSite({ sessionCookie: 'x' }), '123'),
    /not confirmed/
  );
});

const CLOUDFLARE_CAPTCHA_PAGE = `<html><head><title>Rule34.xxx CAPTCHA</title></head>
<body>Please enter the CAPTCHA to continue.
<script>(function(){window._cf_chl_opt = {cType: 'managed'};
var a = document.createElement('script');
a.src = '/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=1';
}());</script></body></html>`;

test('favorite explains a CAPTCHA challenge instead of dumping the page', async () => {
  const fm = setupFetchMock();
  let verificationReads = 0;
  fm.intercept((url) => url.includes('addfav.php'), {
    status: 403,
    body: CLOUDFLARE_CAPTCHA_PAGE,
    persist: true
  });
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: favHtmlPage([123]),
    persist: true,
    onStart: () => {
      verificationReads += 1;
    }
  });

  await assert.rejects(
    () =>
      gelbooruEngine.favorite!(
        baseSite({ name: 'rule34.xxx', sessionCookie: 'x' }),
        '123'
      ),
    (error: Error & { statusCode?: number }) => {
      assert.match(error.message, /rule34\.xxx asked for a CAPTCHA/);
      assert.ok(!error.message.includes('<'));
      assert.equal(error.statusCode, 502);
      return true;
    }
  );
  assert.equal(verificationReads, 0);
});

test('favorite confirms a new favorite from the first page of the list', async () => {
  const fm = setupFetchMock();
  const requestedPids: string[] = [];
  const firstPage = [123, ...Array.from({ length: 49 }, (_, index) => 1000 + index)];
  fm.intercept((url) => url.includes('addfav.php'), { status: 200, body: '3' });
  fm.intercept(
    (url) => {
      const pid = /[?&]pid=(\d+)/.exec(url)?.[1];
      if (!url.includes('s=view') || pid === undefined) return false;
      requestedPids.push(pid);
      return pid === '0';
    },
    { status: 200, body: favHtmlPage(firstPage), persist: true }
  );
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: favHtmlPage([]),
    persist: true
  });

  await gelbooruEngine.favorite!(baseSite({ sessionCookie: 'x' }), '123');
  assert.deepEqual(requestedPids, ['0']);
});

test('favorite still confirms a post that was already favorited further down', async () => {
  const fm = setupFetchMock();
  const firstPage = Array.from({ length: 50 }, (_, index) => 1000 + index);
  fm.intercept((url) => url.includes('addfav.php'), { status: 200, body: '3' });
  fm.intercept((url) => url.includes('s=view') && url.includes('pid=0'), {
    status: 200,
    body: favHtmlPage(firstPage),
    persist: true
  });
  fm.intercept((url) => url.includes('s=view') && url.includes('pid=50'), {
    status: 200,
    body: favHtmlPage([123]),
    persist: true
  });

  await gelbooruEngine.favorite!(baseSite({ sessionCookie: 'x' }), '123');
});

test('favorite refuses without a session cookie', async () => {
  await assert.rejects(
    () => gelbooruEngine.favorite!(baseSite(), '123'),
    /needs a session cookie/
  );
});

const POST_PAGE = `
<ul>
  <li><h6>Artist</h6></li>
  <li class="tag-type-artist tag">
    <a href="index.php?page=wiki&s=list&search=bunsuirei">?</a>
    <a href="index.php?page=post&amp;s=list&amp;tags=bunsuirei">bunsuirei</a>
  </li>
  <li class="tag-type-character"><span class="sm-hidden"><a
    href="index.php?page=wiki&amp;s=list&amp;search=g_%28genesis1556%29">?</a></span></li>
  <li class="tag-type-general tag">
    <a href="index.php?page=wiki&s=list&search=big_breasts">?</a>
    <a href="index.php?page=post&amp;s=list&amp;tags=big_breasts">big breasts</a>
  </li>
  <li class="tag-type-metadata tag">
    <a href="index.php?page=wiki&s=list&search=absurdres">?</a>
  </li>
</ul>`;

test('parsePostPageTags reads names and categories off the post page', () => {
  assert.deepEqual(parsePostPageTags(POST_PAGE), [
    { tag: 'bunsuirei', category: 'artist' },
    { tag: 'g_(genesis1556)', category: 'character' },
    { tag: 'big_breasts', category: 'general' },
    // "metadata" is this family's name for what every other engine calls meta
    { tag: 'absurdres', category: 'meta' }
  ]);
});

test('parsePostPageTags returns nothing for a page without a tag list', () => {
  assert.deepEqual(parsePostPageTags('<html><body>nope</body></html>'), []);
});

test('fetchPostTags prefers the categorised post page over the API', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('page=post&s=view'), {
    status: 200,
    body: POST_PAGE
  });

  const tags = await gelbooruEngine.fetchPostTags(baseSite(), '123');

  assert.deepEqual(
    tags.map((entry) => entry.category),
    ['artist', 'character', 'general', 'meta']
  );
});

test('fetchPostTags falls back to the flat API list when the page is gone', async () => {
  const fm = setupFetchMock();
  // 404, not a throttle: one page route only, so a retry would find nothing
  // registered and throw rather than reaching the fallback below.
  fm.intercept((url) => url.includes('page=post&s=view'), {
    status: 404,
    body: ''
  });
  fm.intercept((url) => url.includes('s=post&q=index'), {
    status: 200,
    body: JSON.stringify([{ id: 123, tags: 'alpha beta' }])
  });

  const tags = await gelbooruEngine.fetchPostTags(baseSite(), '123');

  assert.deepEqual(tags, [
    { tag: 'alpha', category: 'general' },
    { tag: 'beta', category: 'general' }
  ]);
});

test('fetchPostTags waits out a throttle rather than losing the categories', async () => {
  const fm = setupFetchMock();
  // Consumed in order: the first page attempt is throttled, the retry lands.
  fm.intercept((url) => url.includes('page=post&s=view'), {
    status: 429,
    body: ''
  });
  fm.intercept((url) => url.includes('page=post&s=view'), {
    status: 200,
    body: POST_PAGE
  });

  const tags = await gelbooruEngine.fetchPostTags(baseSite(), '123');

  assert.deepEqual(
    tags.map((entry) => entry.category),
    ['artist', 'character', 'general', 'meta']
  );
});
