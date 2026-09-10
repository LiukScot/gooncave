import assert from 'node:assert/strict';

import { afterEach, test } from 'bun:test';
import { fetch as undiciFetch } from 'undici';

import {
  disarmFetchMock,
  setupFetchMock
} from '../../../test/helpers/fetchMock';
import type { BooruSiteRecord } from '../../db/types';

import { createFurAffinityEngine } from './furaffinity';

afterEach(disarmFetchMock);

const site = (
  overrides: Partial<BooruSiteRecord> = {}
): BooruSiteRecord => ({
  id: 'fa-site',
  userId: 'user-1',
  name: 'FurAffinity',
  engine: 'furaffinity',
  baseUrl: 'https://www.furaffinity.net',
  username: 'demo',
  apiKey: null,
  sessionCookie: 'a=account; b=session-secret',
  isPreset: false,
  presetKey: null,
  enabled: true,
  siteAutoSyncMidnight: true,
  siteReverseSyncEnabled: true,
  siteAutoFavEnabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides
});

const submission = (
  id: string,
  options: {
    tags?: string;
    fullview?: string;
    action?: 'fav' | 'unfav';
    key?: string;
  } = {}
) => `<html><body id="pageid-submission">
  <img id="submissionImg"
       data-tags="${options.tags ?? 'u_artist c_artwork_digital t_all s_unspecified_any blue_eyes'}"
       data-fullview-src="${options.fullview ?? `//d.furaffinity.net/art/demo/${id}.png`}">
  ${
    options.action
      ? `<a href="/${options.action}/${id}/?key=${options.key ?? 'a'.repeat(64)}">action</a>`
      : ''
  }
</body></html>`;

const favoritesPage = (ids: string[], next?: string) => `<html>
  <body id="pageid-favorites">
    <section id="gallery-favorites">
      ${ids.map((id) => `<figure id="sid-${id}" class="r-general"></figure>`).join('')}
    </section>
    ${next ? `<form action="${next}" method="get"></form>` : ''}
  </body>
</html>`;

const listingPage = (
  id: string,
  options: {
    page?: 'browse' | 'inbox';
    next?: string;
    previous?: string;
  } = {}
) => `<html><body id="pageid-${options.page === 'browse' ? 'browse' : 'messages'}">
  ${options.page === 'browse' ? '' : '<div id="messagecenter-new-submissions">'}
  <section id="gallery-0">
    <figure id="sid-${id}" class="r-mature t-image">
      <a href="/view/${id}/"><img
        src="//t.furaffinity.net/${id}@300-1788069904.jpg"
        data-width="167.912"
        data-height="250"
        data-tags="u__Peyote c_artwork_digital t_portraits s_wolf blue_eyes"></a>
      <figcaption><a href="/view/${id}/">A title</a><a href="/user/~Peyote/">~Peyote</a></figcaption>
    </figure>
  </section>
  ${
    options.next
      ? `<form id="messages-form" action="/msg/submissions/new@48/"></form>
         ${
           options.previous
             ? `<a class="button standard more-half prev" href="${options.previous}">Prev. 48</a>
                <a class="button standard more-half" href="${options.next}">Next 48</a>`
             : `<a class="button standard more" href="${options.next}">Next 48</a>`
         }`
      : ''
  }
  ${options.page === 'browse' ? '' : '</div>'}
</body></html>`;

const engine = () =>
  createFurAffinityEngine({
    minRequestIntervalMs: 0,
    requestTimeoutMs: 100,
    retryDelaysMs: [0, 0]
  });

test('parses FurAffinity namespaced tags and drops placeholder metadata', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('/view/42/'), {
    status: 200,
    body: submission('42', {
      tags:
        'u__peyote u_peyote c_artwork_digital t_portraits s_dog_other t_all s_unspecified_any blue_eyes'
    })
  });

  const tags = await engine().fetchPostTags(site(), '42');

  assert.deepEqual(tags, [
    { tag: 'peyote', category: 'artist' },
    { tag: 'artwork_digital', category: 'meta' },
    { tag: 'portraits', category: 'meta' },
    { tag: 'dog_other', category: 'species' },
    { tag: 'blue_eyes', category: 'general' }
  ]);
});

test('returns no tags for a confirmed missing submission', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('/view/404/'), {
    status: 200,
    body: '<html><title>System Error</title>The submission you are trying to find is not in our database.</html>'
  });

  assert.deepEqual(await engine().fetchPostTags(site(), '404'), []);
});

test('resolves a listing post to its full-size file only when requested', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/view/42/'), {
    status: 200,
    body: submission('42', {
      fullview: '//d.furaffinity.net/art/demo/full-size.png'
    })
  });

  assert.equal(
    await engine().resolvePostFileUrl!(site(), '42'),
    'https://d.furaffinity.net/art/demo/full-size.png'
  );
});

test('reads Explore detail tags and full-size file in one request', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/view/42/'), {
    status: 200,
    body: submission('42', {
      tags: 'u_artist s_wolf blue_eyes',
      fullview: '//d.furaffinity.net/art/demo/full-size.png'
    })
  });

  assert.deepEqual(await engine().fetchPostDetails!(site(), '42'), {
    tags: [
      { tag: 'artist', category: 'artist' },
      { tag: 'wolf', category: 'species' },
      { tag: 'blue_eyes', category: 'general' }
    ],
    relations: { parentId: null, hasChildren: false, poolIds: [] },
    fileUrl: 'https://d.furaffinity.net/art/demo/full-size.png'
  });
});

test('coalesces concurrent reads of the same submission', async () => {
  let requestCount = 0;
  let releaseRequest = () => {};
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const inspectingFetch = (async () => {
    requestCount += 1;
    await requestGate;
    return new Response(submission('42'), { status: 200 });
  }) as unknown as typeof undiciFetch;
  const inspecting = createFurAffinityEngine({
    fetchImpl: inspectingFetch,
    minRequestIntervalMs: 0,
    requestTimeoutMs: 100,
    retryDelaysMs: []
  });

  const tags = inspecting.fetchPostTags(site(), '42');
  const details = inspecting.fetchPostDetails!(site(), '42');
  releaseRequest();

  await Promise.all([tags, details]);
  assert.equal(requestCount, 1);
});

test('rejects a challenge page instead of treating it as missing content', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('/view/42/'), {
    status: 200,
    body: '<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script></html>'
  });

  await assert.rejects(
    () => engine().fetchPostTags(site(), '42'),
    /blocked|challenge/i
  );
});

test('walks form-action cursors and resolves full-size favorite files', async () => {
  const fm = setupFetchMock();
  const next = '/favorites/demo/900/next';
  fm.intercept((url) => url.endsWith('/favorites/demo/'), {
    status: 200,
    body: favoritesPage(['11'], next)
  });
  fm.intercept((url) => url.endsWith(next), {
    status: 200,
    body: favoritesPage(['10'])
  });
  fm.intercept((url) => url.endsWith('/view/11/'), {
    status: 200,
    body: submission('11')
  });
  fm.intercept((url) => url.endsWith('/view/10/'), {
    status: 200,
    body: submission('10')
  });

  const pages: Array<[number, number]> = [];
  const resolved: Array<[number, number]> = [];
  const streamed: string[] = [];
  const result = await engine().fetchFavorites!(site(), {
    onPage: (page, count) => pages.push([page, count]),
    onItem: (processed, total) => resolved.push([processed, total]),
    onFavoriteResolved: async (item, headers, total) => {
      assert.deepEqual(headers, { 'User-Agent': 'GoonCave (made by liukscot)' });
      assert.equal(total, 2);
      streamed.push(item.remoteId);
    }
  });

  assert.deepEqual(pages, [
    [1, 1],
    [2, 1]
  ]);
  assert.deepEqual(resolved, [
    [0, 2],
    [1, 2],
    [2, 2]
  ]);
  assert.deepEqual(streamed, ['11', '10']);
  assert.deepEqual(
    result.items.map((item) => [item.remoteId, item.fileUrl]),
    [
      ['11', 'https://d.furaffinity.net/art/demo/11.png'],
      ['10', 'https://d.furaffinity.net/art/demo/10.png']
    ]
  );
  assert.deepEqual(result.downloadHeaders, {
    'User-Agent': 'GoonCave (made by liukscot)'
  });
});

test('accepts a valid empty favorites gallery', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/favorites/demo/'), {
    status: 200,
    body: favoritesPage([])
  });

  const result = await engine().fetchFavorites!(site());
  assert.deepEqual(result.items, []);
});

test('keeps a remote favorite id when its submission page is temporarily unavailable', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/favorites/demo/'), {
    status: 200,
    body: favoritesPage(['11', '10'])
  });
  fm.intercept((url) => url.endsWith('/view/11/'), {
    status: 500,
    body: 'temporary failure'
  });
  fm.intercept((url) => url.endsWith('/view/10/'), {
    status: 200,
    body: submission('10')
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await engine().fetchFavorites!(site());
    assert.deepEqual(
      result.items.map((item) => [item.remoteId, item.fileUrl]),
      [
        ['11', null],
        ['10', 'https://d.furaffinity.net/art/demo/10.png']
      ]
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('rejects an invalid favorites page before delete-missing sees an empty set', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/favorites/demo/'), {
    status: 200,
    body: '<html><body>unexpected upstream page</body></html>'
  });

  await assert.rejects(
    () => engine().fetchFavorites!(site()),
    /unexpected favorites page/i
  );
});

test('rejects a repeated favorites cursor', async () => {
  const fm = setupFetchMock();
  const next = '/favorites/demo/900/next';
  fm.intercept((url) => url.endsWith('/favorites/demo/'), {
    status: 200,
    body: favoritesPage(['11'], next)
  });
  fm.intercept((url) => url.endsWith(next), {
    status: 200,
    body: favoritesPage(['10'], next)
  });

  await assert.rejects(
    () => engine().fetchFavorites!(site()),
    /cursor repeated/i
  );
});

test('favorite follows the page token and verifies the resulting state', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/view/42/'), {
    status: 200,
    body: submission('42', { action: 'fav' })
  });
  fm.intercept((url) => url.includes('/fav/42/?key='), {
    status: 302,
    headers: { location: '/view/42/' }
  });
  fm.intercept((url) => url.endsWith('/view/42/'), {
    status: 200,
    body: submission('42', { action: 'unfav' })
  });

  await engine().favorite!(site(), '42');
});

test('favorite is a no-op when the submission is already favorited', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/view/42/'), {
    status: 200,
    body: submission('42', { action: 'unfav' })
  });

  await engine().favorite!(site(), '42');
});

test('unfavorite follows the page token and verifies the resulting state', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/view/42/'), {
    status: 200,
    body: submission('42', { action: 'unfav' })
  });
  fm.intercept((url) => url.includes('/unfav/42/?key='), {
    status: 302,
    headers: { location: '/view/42/' }
  });
  fm.intercept((url) => url.endsWith('/view/42/'), {
    status: 200,
    body: submission('42', { action: 'fav' })
  });

  await engine().unfavorite!(site(), '42');
});

test('unfavorite fails when the verification page still offers unfavorite', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/view/42/'), {
    status: 200,
    body: submission('42', { action: 'unfav' })
  });
  fm.intercept((url) => url.includes('/unfav/42/?key='), {
    status: 302,
    headers: { location: '/view/42/' }
  });
  fm.intercept((url) => url.endsWith('/view/42/'), {
    status: 200,
    body: submission('42', { action: 'unfav' })
  });

  await assert.rejects(
    () => engine().unfavorite!(site(), '42'),
    /not confirmed/i
  );
});

test('cookie check uses a current browse post and authenticated action token', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/browse/'), {
    status: 200,
    body: '<html><body id="pageid-browse"><figure id="sid-42"></figure></body></html>'
  });
  fm.intercept((url) => url.endsWith('/view/42/'), {
    status: 200,
    body: submission('42', { action: 'fav' })
  });

  assert.deepEqual(await engine().checkSessionCookie!(site()), { ok: true });
});

test('authenticated page requests carry the configured cookie', async () => {
  let sentHeaders: HeadersInit | undefined;
  const inspectingFetch = ((_input: unknown, init?: RequestInit) => {
    sentHeaders = init?.headers;
    return Promise.resolve(
      new Response(submission('42'), {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
    );
  }) as unknown as typeof undiciFetch;
  const inspecting = createFurAffinityEngine({
    fetchImpl: inspectingFetch,
    minRequestIntervalMs: 0,
    requestTimeoutMs: 100,
    retryDelaysMs: []
  });

  await inspecting.fetchPostTags(site(), '42');

  assert.equal(new Headers(sentHeaders).get('cookie'), site().sessionCookie);
});

test('paces consecutive requests and exponentially backs off retryable failures', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/view/1/'), {
    status: 503,
    body: 'temporary'
  });
  fm.intercept((url) => url.endsWith('/view/1/'), {
    status: 200,
    body: submission('1')
  });
  fm.intercept((url) => url.endsWith('/view/2/'), {
    status: 200,
    body: submission('2')
  });

  let now = 0;
  const waits: number[] = [];
  const paced = createFurAffinityEngine({
    minRequestIntervalMs: 1_000,
    requestTimeoutMs: 100,
    retryDelaysMs: [2_000, 4_000],
    now: () => now,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    }
  });

  await paced.fetchPostTags(site(), '1');
  await paced.fetchPostTags(site(), '2');

  assert.deepEqual(waits, [2_000, 1_000]);
});

test('honors an already-aborted favorites sync signal', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => engine().fetchFavorites!(site(), { signal: controller.signal }),
    /aborted/i
  );
});

test('stops favorites pagination when the sync is cancelled', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/favorites/demo/'), {
    status: 200,
    body: favoritesPage(['42'], '/favorites/demo/42/next')
  });
  const controller = new AbortController();

  await assert.rejects(
    () =>
      engine().fetchFavorites!(site(), {
        signal: controller.signal,
        onPage: () => controller.abort()
      }),
    /aborted/i
  );
});

test('times out a request instead of leaving the tagging pipeline hanging', async () => {
  const neverFetch = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new Error('request aborted by deadline')),
        { once: true }
      );
    })) as unknown as typeof undiciFetch;
  const timed = createFurAffinityEngine({
    fetchImpl: neverFetch,
    minRequestIntervalMs: 0,
    requestTimeoutMs: 1,
    retryDelaysMs: []
  });

  await assert.rejects(
    () => timed.fetchPostTags(site(), '42'),
    /request failed after retries.*deadline/i
  );
});

test('redacts cookies and action keys from transport errors', async () => {
  const secret = site().sessionCookie!;
  const leakingFetch = (() =>
    Promise.reject(
      new Error(`${secret} https://www.furaffinity.net/fav/42/?key=topsecret`)
    )) as unknown as typeof undiciFetch;
  const guarded = createFurAffinityEngine({
    fetchImpl: leakingFetch,
    minRequestIntervalMs: 0,
    requestTimeoutMs: 100,
    retryDelaysMs: []
  });

  let message = '';
  try {
    await guarded.fetchPostTags(site(), '42');
  } catch (error) {
    message = (error as Error).message;
  }
  assert.ok(message);
  assert.equal(message.includes(secret), false);
  assert.equal(message.includes('topsecret'), false);
});

test('matches FurAffinity URL variants but rejects unrelated paths and hosts', () => {
  const fa = engine();
  for (const url of [
    'https://www.furaffinity.net/view/42/',
    'https://furaffinity.net/view/42',
    'https://sfw.furaffinity.net/full/42/'
  ]) {
    assert.deepEqual(fa.extractIdFromUrl(url, site()), { remoteId: '42' });
  }
  assert.equal(
    fa.extractIdFromUrl('https://xfuraffinity.net/view/42/', site()),
    null
  );
  assert.equal(
    fa.extractIdFromUrl('https://www.furaffinity.net/journal/42/', site()),
    null
  );
  assert.equal(
    fa.buildPostUrl(site({ baseUrl: 'https://sfw.furaffinity.net' }), '42'),
    'https://www.furaffinity.net/view/42/'
  );
});

test('serves only the new Explore sort from browse listings', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/browse/'), {
    status: 200,
    body: listingPage('66198823', { page: 'browse' })
  });

  const result = await engine().searchPosts!(site(), {
    tags: [],
    sort: 'new',
    window: 'day',
    date: '2026-09-10',
    page: 1,
    limit: 40
  });

  assert.equal(result.posts.length, 1);
  assert.deepEqual(result.posts[0], {
    remoteId: '66198823',
    previewUrl: 'https://t.furaffinity.net/66198823@300-1788069904.jpg',
    sampleUrl: 'https://t.furaffinity.net/66198823@300-1788069904.jpg',
    fileUrl: null,
    width: 168,
    height: 250,
    score: null,
    rating: 'mature',
    md5: null,
    createdAt: '2026-08-30T06:05:04.000Z',
    tags: [
      { tag: 'peyote', category: 'artist' },
      { tag: 'artwork_digital', category: 'meta' },
      { tag: 'portraits', category: 'meta' },
      { tag: 'wolf', category: 'species' },
      { tag: 'blue_eyes', category: 'general' }
    ],
    favCount: null,
    uploader: '~Peyote',
    fileExt: null,
    fileSize: null,
    favorited: null,
    voted: null,
    parentId: null,
    hasChildren: false,
    poolIds: null
  });
  assert.deepEqual(result.downloadHeaders, {
    'User-Agent': 'GoonCave (made by liukscot)'
  });
});

test('rejects unsupported FurAffinity Explore sorts and tag search', async () => {
  await assert.rejects(
    () =>
      engine().searchPosts!(site(), {
        tags: [],
        sort: 'popular',
        window: 'day',
        date: '2026-09-10',
        page: 1,
        limit: 40
      }),
    /only supports the New sort/i
  );
  await assert.rejects(
    () =>
      engine().searchPosts!(site(), {
        tags: ['wolf'],
        sort: 'new',
        window: 'day',
        date: '2026-09-10',
        page: 1,
        limit: 40
      }),
    /does not support tag search/i
  );
});

test('reads the watchlist once, dedupes artists and removes the viewer', async () => {
  const fm = setupFetchMock();
  fm.intercept((url) => url.endsWith('/watchlist/by/demo/'), {
    status: 200,
    body: `<html><title>Buddy list -- Fur Affinity [dot] net</title>
      <a href="/user/demo/">demo</a>
      <a href="/user/WolfArtist/">WolfArtist</a>
      <a href="/user/wolfartist/">wolfartist</a>
      <a href="/user/FoxArtist/">FoxArtist</a></html>`
  });

  assert.deepEqual(await engine().listArtistSubscriptions!(site()), [
    'FoxArtist',
    'WolfArtist'
  ]);
});

test('reads and cursor-paginates the FurAffinity subscription inbox', async () => {
  const fm = setupFetchMock();
  const next = '/msg/submissions/new~66198823@48/';
  const last = '/msg/submissions/new~66190000@48/';
  fm.intercept((url) => url.endsWith('/msg/submissions/'), {
    status: 200,
    body: listingPage('66198823', { next })
  });
  fm.intercept((url) => url.endsWith(next), {
    status: 200,
    body: listingPage('66190000', {
      previous: '/msg/submissions/new~66200000@48/',
      next: last
    })
  });
  fm.intercept((url) => url.endsWith(last), {
    status: 200,
    body: listingPage('66180000')
  });

  const first = await engine().fetchSubscriptionPosts!(site(), null);
  const second = await engine().fetchSubscriptionPosts!(site(), first.nextCursor);
  const third = await engine().fetchSubscriptionPosts!(site(), second.nextCursor);

  assert.equal(first.posts[0].remoteId, '66198823');
  assert.equal(first.nextCursor, next);
  assert.equal(second.posts[0].remoteId, '66190000');
  assert.equal(second.nextCursor, last);
  assert.equal(third.posts[0].remoteId, '66180000');
  assert.equal(third.nextCursor, null);
});

test('rejects a subscription cursor that points back to itself', async () => {
  const fm = setupFetchMock();
  const cursor = '/msg/submissions/new~66198823@48/';
  fm.intercept((url) => url.endsWith(cursor), {
    status: 200,
    body: listingPage('66190000', {
      previous: '/msg/submissions/new~66200000@48/',
      next: cursor
    })
  });

  await assert.rejects(
    () => engine().fetchSubscriptionPosts!(site(), cursor),
    /cursor loop/i
  );
});

test('watch and unwatch use the page token and verify final state', async () => {
  const fm = setupFetchMock();
  const userPage = (action: 'watch' | 'unwatch') =>
    `<html><body id="pageid-userpage"><a href="/${action}/WolfArtist/?key=${'a'.repeat(64)}">${action}</a></body></html>`;
  fm.intercept((url) => url.endsWith('/user/WolfArtist/'), {
    status: 200,
    body: userPage('watch')
  });
  fm.intercept((url) => url.includes('/watch/WolfArtist/?key='), {
    status: 302,
    headers: { location: '/user/WolfArtist/' }
  });
  fm.intercept((url) => url.endsWith('/user/WolfArtist/'), {
    status: 200,
    body: userPage('unwatch')
  });
  fm.intercept((url) => url.endsWith('/user/WolfArtist/'), {
    status: 200,
    body: userPage('unwatch')
  });
  fm.intercept((url) => url.includes('/unwatch/WolfArtist/?key='), {
    status: 302,
    headers: { location: '/user/WolfArtist/' }
  });
  fm.intercept((url) => url.endsWith('/user/WolfArtist/'), {
    status: 200,
    body: userPage('watch')
  });

  await engine().subscribeArtist!(site(), 'WolfArtist');
  await engine().unsubscribeArtist!(site(), 'WolfArtist');
});
