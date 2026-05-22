// CRUD + data-integrity contract for user_booru_sites. The headline case:
// deleting a custom site must purge its favorite_items rows (they're keyed by
// the site UUID with no FK), otherwise those rows orphan and reverse-sync
// silently no-ops.
import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { seedUser } from '../../test/helpers/testApp';

import { dataStore } from './dataStore';

test('deleteBooruSite purges favorite_items rows owned by the deleted custom site', async () => {
  const seeded = await seedUser({ username: 'delete-cascade' });

  const site = await dataStore.insertBooruSite(
    {
      name: 'My booru',
      engine: 'szurubooru',
      baseUrl: 'https://my.example.com',
      isPreset: false,
      presetKey: null,
      enabled: true,
      capFavorites: true,
      capTags: true,
      capSourceMatch: true,
      capSearch: false
    },
    seeded.user.id
  );

  // Favorites for a custom site are keyed by the site UUID.
  await dataStore.upsertFavoriteItem(
    {
      provider: site.id,
      remoteId: '1',
      filePath: '/tmp/a.jpg',
      sourceUrl: 'https://my.example.com/post/1',
      fileUrl: null
    },
    seeded.user.id
  );
  assert.equal((await dataStore.listFavoriteItems(site.id, seeded.user.id)).length, 1);

  const removed = await dataStore.deleteBooruSite(site.id, seeded.user.id);
  assert.equal(removed, true);

  // Site gone AND its favorites gone — no orphans.
  assert.equal(await dataStore.getBooruSite(site.id, seeded.user.id), null);
  assert.equal((await dataStore.listFavoriteItems(site.id, seeded.user.id)).length, 0);
});

test('deleteBooruSite refuses to delete preset rows and leaves them intact', async () => {
  const seeded = await seedUser({ username: 'delete-preset' });
  const preset = await dataStore.insertBooruSite(
    {
      name: 'e621',
      engine: 'e621',
      baseUrl: 'https://e621.net',
      isPreset: true,
      presetKey: 'E621',
      enabled: true,
      capFavorites: true,
      capTags: true,
      capSourceMatch: true,
      capSearch: false
    },
    seeded.user.id
  );
  const removed = await dataStore.deleteBooruSite(preset.id, seeded.user.id);
  assert.equal(removed, false);
  assert.ok(await dataStore.getBooruSite(preset.id, seeded.user.id));
});

test('deleteBooruSite does not touch another user\'s favorites that share a remote id', async () => {
  const a = await seedUser({ username: 'cascade-user-a' });
  const b = await seedUser({ username: 'cascade-user-b' });
  const siteA = await dataStore.insertBooruSite(
    { name: 'A', engine: 'szurubooru', baseUrl: 'https://a.example.com', isPreset: false, presetKey: null, enabled: true, capFavorites: true, capTags: true, capSourceMatch: true, capSearch: false },
    a.user.id
  );
  // user B has a favorite under a legacy preset key, unrelated to siteA.id
  await dataStore.upsertFavoriteItem(
    { provider: 'E621', remoteId: '99', filePath: '/tmp/b.jpg', sourceUrl: null, fileUrl: null },
    b.user.id
  );
  await dataStore.deleteBooruSite(siteA.id, a.user.id);
  assert.equal((await dataStore.listFavoriteItems('E621', b.user.id)).length, 1);
});
