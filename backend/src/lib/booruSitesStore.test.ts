// CRUD + data-integrity contract for user_booru_sites. The headline case:
// deleting a custom site must purge its favorite_items rows (they're keyed by
// the site UUID with no FK), otherwise those rows orphan and reverse-sync
// silently no-ops.
import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { seedUser } from '../../test/helpers/testApp';
import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { favoritesRepo } from '../db/repos/favoritesRepo';

test('deleteBooruSite purges favorite_items rows owned by the deleted custom site', async () => {
  const seeded = await seedUser({ username: 'delete-cascade' });

  const site = await booruSitesRepo.insertBooruSite(
    {
      name: 'My booru',
      engine: 'szurubooru',
      baseUrl: 'https://my.example.com',
      isPreset: false,
      presetKey: null,
      enabled: true
    },
    seeded.user.id
  );

  // Favorites for a custom site are keyed by the site UUID.
  await favoritesRepo.upsertFavoriteItem(
    {
      provider: site.id,
      remoteId: '1',
      filePath: '/tmp/a.jpg',
      sourceUrl: 'https://my.example.com/post/1',
      fileUrl: null
    },
    seeded.user.id
  );
  assert.equal(
    (await favoritesRepo.listFavoriteItems(site.id, seeded.user.id)).length,
    1
  );

  const removed = await booruSitesRepo.deleteBooruSite(site.id, seeded.user.id);
  assert.equal(removed, true);

  // Site gone AND its favorites gone — no orphans.
  assert.equal(
    await booruSitesRepo.getBooruSite(site.id, seeded.user.id),
    null
  );
  assert.equal(
    (await favoritesRepo.listFavoriteItems(site.id, seeded.user.id)).length,
    0
  );
});

test('deleteBooruSite deletes preset row and purges preset-key favorites', async () => {
  const seeded = await seedUser({ username: 'delete-preset' });
  const preset = await booruSitesRepo.insertBooruSite(
    {
      name: 'e621',
      engine: 'e621',
      baseUrl: 'https://e621.net',
      isPreset: true,
      presetKey: 'E621',
      enabled: true
    },
    seeded.user.id
  );
  await favoritesRepo.upsertFavoriteItem(
    {
      provider: 'E621',
      remoteId: '123',
      filePath: '/tmp/e621.jpg',
      sourceUrl: 'https://e621.net/posts/123',
      fileUrl: null
    },
    seeded.user.id
  );
  const removed = await booruSitesRepo.deleteBooruSite(
    preset.id,
    seeded.user.id
  );
  assert.equal(removed, true);
  assert.equal(
    await booruSitesRepo.getBooruSite(preset.id, seeded.user.id),
    null
  );
  assert.equal(
    (await favoritesRepo.listFavoriteItems('E621', seeded.user.id)).length,
    0
  );
});

test('updateBooruSite persists preset flags when explicitly changed', async () => {
  const seeded = await seedUser({ username: 'update-preset-flags' });
  const site = await booruSitesRepo.insertBooruSite(
    {
      name: 'Custom',
      engine: 'gelbooru',
      baseUrl: 'https://custom.example.com',
      isPreset: false,
      presetKey: null,
      enabled: true
    },
    seeded.user.id
  );

  const updated = await booruSitesRepo.updateBooruSite(
    site.id,
    { isPreset: true, presetKey: 'CUSTOM_PRESET' },
    seeded.user.id
  );

  assert.equal(updated?.isPreset, true);
  assert.equal(updated?.presetKey, 'CUSTOM_PRESET');
});

test("deleteBooruSite does not touch another user's favorites that share a remote id", async () => {
  const a = await seedUser({ username: 'cascade-user-a' });
  const b = await seedUser({ username: 'cascade-user-b' });
  const siteA = await booruSitesRepo.insertBooruSite(
    {
      name: 'A',
      engine: 'szurubooru',
      baseUrl: 'https://a.example.com',
      isPreset: false,
      presetKey: null,
      enabled: true
    },
    a.user.id
  );
  // user B has a favorite under the same provider key shape site deletes use.
  await favoritesRepo.upsertFavoriteItem(
    {
      provider: siteA.id,
      remoteId: '99',
      filePath: '/tmp/b.jpg',
      sourceUrl: null,
      fileUrl: null
    },
    b.user.id
  );
  await booruSitesRepo.deleteBooruSite(siteA.id, a.user.id);
  assert.equal(
    (await favoritesRepo.listFavoriteItems(siteA.id, b.user.id)).length,
    1
  );
});
