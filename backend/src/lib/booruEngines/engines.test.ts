// Unit tests for the engine modules' pure pieces — probe shape detection and
// URL → post-id extraction. No network. No DB. These pin the contract that the
// detection module and the URL matcher rely on.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BooruSiteRecord } from '../../db/types';

import { danbooruEngine } from './danbooru';
import { e621Engine } from './e621';
import { gelbooruEngine } from './gelbooru';
import { moebooruEngine } from './moebooru';
import { philomenaEngine } from './philomena';
import { sankakuEngine } from './sankaku';
import { shimmieEngine } from './shimmie';
import { szurubooruEngine } from './szurubooru';

const baseSite = (overrides: Partial<BooruSiteRecord>): BooruSiteRecord => ({
  id: 'site-1',
  userId: 'user-1',
  name: 'test',
  engine: 'e621',
  baseUrl: 'https://e621.net',
  username: null,
  apiKey: null,
  isPreset: false,
  presetKey: null,
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides
});

test('e621 probe matches typed-tag-bucket shape', () => {
  const body = { posts: [{ tags: { general: ['cat'] } }] };
  assert.equal(e621Engine.probeMatches(body), true);
});

test('e621 probe rejects flat tag-string shape (danbooru-style)', () => {
  const body = { posts: [{ tag_string_general: 'cat' }] };
  assert.equal(e621Engine.probeMatches(body), false);
});

test('danbooru probe matches flat tag-string shape', () => {
  const body = [{ tag_string_general: 'cat' }];
  assert.equal(danbooruEngine.probeMatches(body), true);
});

test('danbooru probe rejects e621-style body', () => {
  const body = { posts: [{ tags: { general: ['x'] } }] };
  assert.equal(danbooruEngine.probeMatches(body), false);
});

test('moebooru probe matches flat string tags + md5', () => {
  const body = [{ tags: 'cat dog', md5: 'abcd' }];
  assert.equal(moebooruEngine.probeMatches(body), true);
});

test('moebooru probe rejects danbooru-style flat tag-string', () => {
  const body = [{ tags: 'a', md5: 'x', tag_string_general: 'cat' }];
  assert.equal(moebooruEngine.probeMatches(body), false);
});

test('gelbooru probe matches object envelope', () => {
  const body = { post: [{ tags: 'x', file_url: 'https://example.com/x.jpg' }] };
  assert.equal(gelbooruEngine.probeMatches(body), true);
});

test('philomena probe matches images array with tag arrays', () => {
  const body = { images: [{ id: 1, tags: ['a'] }] };
  assert.equal(philomenaEngine.probeMatches(body), true);
});

test('sankaku probe matches typed tag entries', () => {
  const body = [{ id: 1, tags: [{ name: 'cat', type: 0 }] }];
  assert.equal(sankakuEngine.probeMatches(body), true);
});

test('e621 extractIdFromUrl matches canonical /posts/{id}', () => {
  const site = baseSite({ engine: 'e621', baseUrl: 'https://e621.net' });
  assert.deepEqual(
    e621Engine.extractIdFromUrl('https://e621.net/posts/12345', site),
    { remoteId: '12345' }
  );
});

test('e621 extractIdFromUrl rejects wrong host', () => {
  const site = baseSite({ engine: 'e621', baseUrl: 'https://e621.net' });
  assert.equal(
    e621Engine.extractIdFromUrl('https://danbooru.donmai.us/posts/42', site),
    null
  );
});

test('danbooru extractIdFromUrl matches /posts/{id}', () => {
  const site = baseSite({
    engine: 'danbooru',
    baseUrl: 'https://danbooru.donmai.us'
  });
  assert.deepEqual(
    danbooruEngine.extractIdFromUrl(
      'https://danbooru.donmai.us/posts/777',
      site
    ),
    { remoteId: '777' }
  );
});

test('moebooru extractIdFromUrl matches /post/show/{id}', () => {
  const site = baseSite({ engine: 'moebooru', baseUrl: 'https://yande.re' });
  assert.deepEqual(
    moebooruEngine.extractIdFromUrl('https://yande.re/post/show/9001', site),
    { remoteId: '9001' }
  );
});

test('gelbooru extractIdFromUrl reads id query parameter', () => {
  const site = baseSite({
    engine: 'gelbooru',
    baseUrl: 'https://gelbooru.com'
  });
  assert.deepEqual(
    gelbooruEngine.extractIdFromUrl(
      'https://gelbooru.com/index.php?page=post&s=view&id=42',
      site
    ),
    { remoteId: '42' }
  );
});

test('philomena extractIdFromUrl matches /images/{id}', () => {
  const site = baseSite({
    engine: 'philomena',
    baseUrl: 'https://derpibooru.org'
  });
  assert.deepEqual(
    philomenaEngine.extractIdFromUrl(
      'https://derpibooru.org/images/12345',
      site
    ),
    { remoteId: '12345' }
  );
});

test('sankaku extractIdFromUrl matches /post/show/{id}', () => {
  const site = baseSite({
    engine: 'sankaku',
    baseUrl: 'https://chan.sankakucomplex.com'
  });
  assert.deepEqual(
    sankakuEngine.extractIdFromUrl(
      'https://chan.sankakucomplex.com/post/show/42',
      site
    ),
    { remoteId: '42' }
  );
});

test('engine buildPostUrl returns canonical URL', () => {
  const site = baseSite({ engine: 'e621', baseUrl: 'https://e621.net' });
  assert.equal(
    e621Engine.buildPostUrl(site, '42'),
    'https://e621.net/posts/42'
  );
});

// --- szurubooru ---------------------------------------------------------

test('szurubooru probe matches the szurubooru search envelope', () => {
  const body = {
    query: '',
    offset: 0,
    limit: 1,
    total: 99,
    results: [
      {
        id: 7,
        tags: [{ names: ['cat'], category: 'general' }],
        thumbnailUrl: '/t/7.jpg'
      }
    ]
  };
  assert.equal(szurubooruEngine.probeMatches(body), true);
});

test('szurubooru probe matches empty boards (count zero is still a valid szurubooru)', () => {
  const body = { query: '', offset: 0, limit: 1, total: 0, results: [] };
  assert.equal(szurubooruEngine.probeMatches(body), true);
});

test('szurubooru probe rejects danbooru-style flat tag string', () => {
  // Disambiguation: szurubooru tags are objects with `names: string[]`,
  // never the flat `tag_string_general` shape that danbooru uses.
  const body = { results: [{ id: 1, tag_string_general: 'cat' }] };
  assert.equal(szurubooruEngine.probeMatches(body), false);
});

test('szurubooru probeSample returns id, thumbnail, and /post/{id} path', () => {
  const body = {
    results: [
      {
        id: 42,
        thumbnailUrl: '/t/42.jpg',
        tags: [{ names: ['cat'], category: 'general' }]
      }
    ]
  };
  const sample = szurubooruEngine.probeSample?.(body);
  assert.deepEqual(sample, {
    postId: '42',
    thumbUrl: '/t/42.jpg',
    postPath: '/post/42'
  });
});

test('szurubooru extractIdFromUrl matches /post/{id}', () => {
  const site = baseSite({
    engine: 'szurubooru',
    baseUrl: 'https://booru.foalcon.com'
  });
  assert.deepEqual(
    szurubooruEngine.extractIdFromUrl(
      'https://booru.foalcon.com/post/12345',
      site
    ),
    { remoteId: '12345' }
  );
});

// --- shimmie ------------------------------------------------------------

test('shimmie probe matches a danbooru-compat XML response with one post', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<posts count="1" offset="0">
  <tag name="cat" count="3" type="general"/>
  <post id="1234" md5="abc" file_url="/f/1234.jpg" preview_url="/t/1234.jpg" tags="cat dog" rating="s"/>
</posts>`;
  assert.equal(shimmieEngine.probeMatches(xml), true);
});

test('shimmie probe accepts an empty board (zero-post XML envelope)', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<posts count="0" offset="0"></posts>`;
  assert.equal(shimmieEngine.probeMatches(xml), true);
});

test('shimmie probe rejects non-string bodies (defends against JSON misdispatch)', () => {
  // The detect loop hands every engine the same parsed body. If JSON.parse
  // succeeded upstream, shimmie must NOT match the resulting object — it
  // only understands raw XML strings.
  assert.equal(
    shimmieEngine.probeMatches({ posts: [{ id: 1 }] } as unknown),
    false
  );
});

test('shimmie probe rejects HTML / arbitrary text', () => {
  assert.equal(
    shimmieEngine.probeMatches('<!DOCTYPE html><html><body>nope</body></html>'),
    false
  );
  assert.equal(shimmieEngine.probeMatches('plain text'), false);
});

test('shimmie probeSample pulls id + preview_url out of the first <post> element', () => {
  const xml = `<posts count="1" offset="0">
    <post id="5678" md5="deadbeef" preview_url="/t/5678.jpg" tags="foo bar"/>
  </posts>`;
  const sample = shimmieEngine.probeSample?.(xml);
  assert.deepEqual(sample, {
    postId: '5678',
    thumbUrl: '/t/5678.jpg',
    postPath: '/post/view/5678'
  });
});

test('shimmie extractIdFromUrl matches /post/view/{id}', () => {
  const site = baseSite({
    engine: 'shimmie',
    baseUrl: 'https://cascards.fluffyquack.com'
  });
  assert.deepEqual(
    shimmieEngine.extractIdFromUrl(
      'https://cascards.fluffyquack.com/post/view/42',
      site
    ),
    { remoteId: '42' }
  );
});

// --- probeSample on the original six engines ---------------------------

test('e621 probeSample returns first post id + preview', () => {
  const body = {
    posts: [{ id: 9, preview: { url: '/p/9.jpg' }, tags: { general: ['cat'] } }]
  };
  assert.deepEqual(e621Engine.probeSample?.(body), {
    postId: '9',
    thumbUrl: '/p/9.jpg',
    postPath: '/posts/9'
  });
});

test('danbooru probeSample returns first post id + preview_file_url', () => {
  const body = [
    { id: 1, preview_file_url: '/p/1.jpg', tag_string_general: 'cat' }
  ];
  assert.deepEqual(danbooruEngine.probeSample?.(body), {
    postId: '1',
    thumbUrl: '/p/1.jpg',
    postPath: '/posts/1'
  });
});

test('philomena probeSample returns image id + thumb representation', () => {
  const body = {
    images: [{ id: 42, representations: { thumb: '/t/42.jpg' }, tags: ['a'] }]
  };
  assert.deepEqual(philomenaEngine.probeSample?.(body), {
    postId: '42',
    thumbUrl: '/t/42.jpg',
    postPath: '/images/42'
  });
});
