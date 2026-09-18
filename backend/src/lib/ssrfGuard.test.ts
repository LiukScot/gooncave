// Pin the SSRF guard: this is the most security-critical path in the codebase.
// Tests use IP literals only — no real DNS lookups occur.
import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';

import { afterEach, test } from 'bun:test';

import { armFetchMock, disarmFetchMock } from '../../test/helpers/fetchMock';

import { danbooruEngine } from './booruEngines/danbooru';
import { assertUrlAllowed, safeFetch, SsrfBlockedError } from './ssrfGuard';

afterEach(() => {
  disarmFetchMock();
  delete process.env.ALLOW_PRIVATE_BOORU_HOSTS;
});

// Keeps the guard on while the mock is armed; without it an armed mock opts out.
const armWithGuard = () => {
  process.env.ALLOW_PRIVATE_BOORU_HOSTS = 'false';
  return armFetchMock();
};

const assertBlocked = async (url: string) => {
  await assert.rejects(
    () => assertUrlAllowed(url),
    (err: unknown) => err instanceof SsrfBlockedError
  );
};

test('allows a public HTTPS URL', async () => {
  // Uses a real public IP — assertUrlAllowed resolves DNS; for CI we use an
  // IP literal so no DNS query is made and the test is fully offline.
  await assert.doesNotReject(() => assertUrlAllowed('https://1.1.1.1/'));
});

test('blocks IPv4 loopback 127.0.0.1', async () => {
  await assertBlocked('http://127.0.0.1/');
});

test('blocks IPv4 loopback 127.0.0.2', async () => {
  await assertBlocked('http://127.0.0.2/secret');
});

test('blocks private range 10.x.x.x', async () => {
  await assertBlocked('http://10.0.0.1/');
});

test('blocks private range 192.168.x.x', async () => {
  await assertBlocked('http://192.168.1.1/');
});

test('blocks private range 172.16.x.x', async () => {
  await assertBlocked('http://172.16.0.1/');
});

test('blocks IPv4-mapped IPv6 loopback ::ffff:127.0.0.1', async () => {
  await assertBlocked('http://[::ffff:127.0.0.1]/');
});

test('blocks IPv4-mapped IPv6 private ::ffff:192.168.1.1', async () => {
  await assertBlocked('http://[::ffff:192.168.1.1]/');
});

test('blocks IPv6 loopback ::1', async () => {
  await assertBlocked('http://[::1]/');
});

test('blocks non-http scheme', async () => {
  await assertBlocked('ftp://1.1.1.1/');
});

test('blocks invalid URL', async () => {
  await assertBlocked('not-a-url');
});

test('safeFetch refuses a redirect to an internal address', async () => {
  const fetchMock = armWithGuard();
  fetchMock.intercept((url) => url === 'https://1.1.1.1/start', {
    status: 302,
    headers: { Location: 'http://127.0.0.1:8000/health' }
  });
  await assert.rejects(safeFetch('https://1.1.1.1/start'), SsrfBlockedError);
});

test('a booru engine request cannot be redirected to an internal address', async () => {
  const fetchMock = armWithGuard();
  fetchMock.intercept((url) => url.startsWith('https://1.1.1.1/posts.json'), {
    status: 302,
    headers: { Location: 'http://169.254.169.254/latest/meta-data' }
  });
  await assert.rejects(
    danbooruEngine.searchPosts!(
      {
        id: 'site-1',
        userId: 'user-1',
        name: 'test',
        engine: 'danbooru',
        baseUrl: 'https://1.1.1.1',
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
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z'
      },
      { tags: [], sort: 'new', limit: 1, page: 1 }
    ),
    SsrfBlockedError
  );
});

test('safeFetch drops credentials when a redirect leaves the origin', async () => {
  const fetchMock = armWithGuard();
  let forwarded: RequestInit | undefined;
  fetchMock.intercept((url) => url === 'https://1.1.1.1/file', {
    status: 302,
    headers: { Location: 'https://1.0.0.1/cdn/file' }
  });
  fetchMock.intercept(
    (url, init) => {
      if (url !== 'https://1.0.0.1/cdn/file') return false;
      forwarded = init;
      return true;
    },
    { status: 200, body: 'ok' }
  );
  const res = await safeFetch('https://1.1.1.1/file', {
    headers: { Authorization: 'Basic secret', 'User-Agent': 'gooncave' }
  });
  assert.equal(res.status, 200);
  const headers = new Headers(forwarded?.headers);
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('user-agent'), 'gooncave');
});

test('safeFetch continues a redirected POST as a body-less GET', async () => {
  const fetchMock = armWithGuard();
  let forwarded: RequestInit | undefined;
  fetchMock.intercept((url) => url === 'https://1.1.1.1/favorites.json', {
    status: 302,
    headers: { Location: '/posts/1' }
  });
  fetchMock.intercept(
    (url, init) => {
      if (url !== 'https://1.1.1.1/posts/1') return false;
      forwarded = init;
      return true;
    },
    { status: 200, body: 'ok' }
  );
  await safeFetch('https://1.1.1.1/favorites.json', {
    method: 'POST',
    headers: { Authorization: 'Basic secret' },
    body: new URLSearchParams({ post_id: '1' })
  });
  assert.equal(forwarded?.method, 'GET');
  assert.equal(forwarded?.body, undefined);
  // Same origin, so the credentials stay.
  assert.equal(
    new Headers(forwarded?.headers).get('authorization'),
    'Basic secret'
  );
});

test("safeFetch hands back the redirect itself under redirect: 'manual'", async () => {
  const fetchMock = armWithGuard();
  fetchMock.intercept((url) => url === 'https://1.1.1.1/addfav', {
    status: 302,
    headers: { Location: 'https://1.1.1.1/login' }
  });
  const res = await safeFetch('https://1.1.1.1/addfav', { redirect: 'manual' });
  assert.equal(res.status, 302);
});
