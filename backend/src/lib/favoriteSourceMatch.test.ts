// URL-matcher built dynamically from a user's user_booru_sites rows. Pins
// the contract for `extractFavoriteRemoteFromSiteList` so that adding /
// removing engines or sites keeps producing the expected `(provider,
// remoteId)` pair for routing favorites + auto-fav decisions.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BooruEngineType, BooruSiteRecord } from './dataStore';
import { extractFavoriteRemoteFromSiteList, extractFavoriteRemoteFromSourceUrl } from './favoriteSourceMatch';

const siteFixture = (overrides: Partial<BooruSiteRecord>): BooruSiteRecord => ({
  id: 'site-' + (overrides.name ?? 'x'),
  userId: 'user-1',
  name: 'fixture',
  engine: 'e621' as BooruEngineType,
  baseUrl: 'https://e621.net',
  username: null,
  apiKey: null,
  isPreset: false,
  presetKey: null,
  enabled: true,
  capFavorites: false,
  capTags: false,
  capSourceMatch: true,
  capSearch: false,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides
});

test('extractFavoriteRemoteFromSiteList resolves canonical e621 URL to its preset site', () => {
  const e621 = siteFixture({ engine: 'e621', baseUrl: 'https://e621.net', isPreset: true, presetKey: 'E621' });
  const result = extractFavoriteRemoteFromSiteList('https://e621.net/posts/42', [e621]);
  assert.ok(result);
  assert.equal(result!.provider, e621.id);
  assert.equal(result!.remoteId, '42');
  assert.equal(result!.site.engine, 'e621');
});

test('extractFavoriteRemoteFromSiteList resolves danbooru URL to danbooru site', () => {
  const danbooru = siteFixture({
    engine: 'danbooru',
    baseUrl: 'https://danbooru.donmai.us',
    isPreset: true,
    presetKey: 'DANBOORU'
  });
  const result = extractFavoriteRemoteFromSiteList('https://danbooru.donmai.us/posts/777', [danbooru]);
  assert.ok(result);
  assert.equal(result!.remoteId, '777');
  assert.equal(result!.site.engine, 'danbooru');
});

test('extractFavoriteRemoteFromSiteList skips sites with capSourceMatch=false', () => {
  const e621 = siteFixture({
    engine: 'e621',
    baseUrl: 'https://e621.net',
    capSourceMatch: false
  });
  // Even though the URL belongs to e621, the user has disabled URL matching
  // for this site, so it must not produce a hit.
  assert.equal(extractFavoriteRemoteFromSiteList('https://e621.net/posts/1', [e621]), null);
});

test('extractFavoriteRemoteFromSiteList skips disabled sites', () => {
  const e621 = siteFixture({
    engine: 'e621',
    baseUrl: 'https://e621.net',
    enabled: false
  });
  assert.equal(extractFavoriteRemoteFromSiteList('https://e621.net/posts/1', [e621]), null);
});

test('extractFavoriteRemoteFromSiteList returns null for URLs no configured site claims', () => {
  const e621 = siteFixture({ engine: 'e621', baseUrl: 'https://e621.net' });
  assert.equal(extractFavoriteRemoteFromSiteList('https://example.com/post/1', [e621]), null);
});

test('extractFavoriteRemoteFromSiteList prefers earlier sortOrder when two sites could match', () => {
  // Two e621 sites for the same user with different base_url; only one
  // matches a given URL. Sort order should make the chosen site
  // deterministic across reads.
  const first = siteFixture({
    id: 'first',
    engine: 'e621',
    baseUrl: 'https://e621.net',
    sortOrder: 0
  });
  const second = siteFixture({
    id: 'second',
    engine: 'e621',
    baseUrl: 'https://e926.net',
    sortOrder: 1
  });
  const result = extractFavoriteRemoteFromSiteList('https://e621.net/posts/9', [second, first]);
  assert.ok(result);
  assert.equal(result!.site.id, 'first');
});

test('extractFavoriteRemoteFromSourceUrl legacy fallback still matches the two original hardcoded providers', () => {
  // This function is kept as a fallback for workers that have no user
  // context; it must continue to recognise the canonical e621 + danbooru
  // post URLs.
  assert.deepEqual(extractFavoriteRemoteFromSourceUrl('https://e621.net/posts/1'), {
    provider: 'E621',
    remoteId: '1'
  });
  assert.deepEqual(extractFavoriteRemoteFromSourceUrl('https://danbooru.donmai.us/posts/2'), {
    provider: 'DANBOORU',
    remoteId: '2'
  });
});
