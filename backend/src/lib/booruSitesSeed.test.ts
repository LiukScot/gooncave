// Seeds existing provider_credentials E621/DANBOORU rows into user_booru_sites
// preset rows on boot. Pin the idempotency contract: running twice must not
// duplicate, and existing preset rows must be left alone.
import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';

import { test } from 'bun:test';

import { seedUser } from '../../test/helpers/testApp';
import { authRepo } from '../db/repos/authRepo';
import { booruSitesRepo } from '../db/repos/booruSitesRepo';

import { seedBooruSitesFromLegacyCredentials } from './booruSitesSeed';

test('seedBooruSitesFromLegacyCredentials creates preset rows from existing E621/DANBOORU credentials', async () => {
  const seeded = await seedUser({ username: 'seed-from-creds' });
  await authRepo.upsertCredential(
    'E621',
    { username: 'e621-user', apiKey: 'e621-key' },
    seeded.user.id
  );
  await authRepo.upsertCredential(
    'DANBOORU',
    { username: 'db-user', apiKey: 'db-key' },
    seeded.user.id
  );

  const result = await seedBooruSitesFromLegacyCredentials();
  assert.ok(result.scannedUsers >= 1);
  assert.ok(result.insertedRows >= 2);

  const e621 = await booruSitesRepo.findBooruSiteByPresetKey(
    'E621',
    seeded.user.id
  );
  assert.ok(e621);
  assert.equal(e621!.engine, 'e621');
  assert.equal(e621!.baseUrl, 'https://e621.net');
  assert.equal(e621!.username, 'e621-user');
  assert.equal(e621!.apiKey, 'e621-key');
  assert.equal(e621!.isPreset, true);

  const danbooru = await booruSitesRepo.findBooruSiteByPresetKey(
    'DANBOORU',
    seeded.user.id
  );
  assert.ok(danbooru);
  assert.equal(danbooru!.username, 'db-user');
  assert.equal(danbooru!.apiKey, 'db-key');
});

test('seedBooruSitesFromLegacyCredentials is idempotent — second run inserts zero rows for already-seeded user', async () => {
  const seeded = await seedUser({ username: 'seed-idempotent' });
  await authRepo.upsertCredential(
    'E621',
    { username: 'u', apiKey: 'k' },
    seeded.user.id
  );

  const first = await seedBooruSitesFromLegacyCredentials();
  const firstInserted = first.insertedRows;
  const second = await seedBooruSitesFromLegacyCredentials();
  // The second call must not touch rows for users already seeded.
  assert.ok(
    second.insertedRows < firstInserted,
    `expected second-pass inserts to drop, got ${second.insertedRows} vs ${firstInserted}`
  );

  const sites = await booruSitesRepo.listBooruSites(seeded.user.id);
  const e621Sites = sites.filter((site) => site.presetKey === 'E621');
  assert.equal(
    e621Sites.length,
    1,
    'should never produce duplicate preset rows for one user'
  );
});

test('seedBooruSitesFromLegacyCredentials skips SAUCENAO credentials (not a booru)', async () => {
  const seeded = await seedUser({ username: 'seed-saucenao-only' });
  await authRepo.upsertCredential(
    'SAUCENAO',
    { apiKey: 'sn-key' },
    seeded.user.id
  );

  await seedBooruSitesFromLegacyCredentials();
  const sites = await booruSitesRepo.listBooruSites(seeded.user.id);
  // SAUCENAO is reverse image search, not a booru — must never end up as a
  // user_booru_sites row.
  assert.equal(sites.length, 0);
});

test('seedBooruSitesFromLegacyCredentials does nothing for users with no booru credentials', async () => {
  const seeded = await seedUser({ username: 'seed-no-creds' });

  await seedBooruSitesFromLegacyCredentials();
  const sites = await booruSitesRepo.listBooruSites(seeded.user.id);
  assert.equal(sites.length, 0);
});

test('seedBooruSitesFromLegacyCredentials fills a key into a site that has none', async () => {
  const seeded = await seedUser({ username: 'seed-stranded-key' });
  // The state this exists for: the site row was added by hand, so the seed's
  // insert pass skips it, and the key stays stranded where nothing reads it.
  await booruSitesRepo.insertBooruSite(
    {
      name: 'e621',
      engine: 'e621',
      baseUrl: 'https://e621.net',
      username: 'e621-user',
      apiKey: null,
      isPreset: true,
      presetKey: 'E621',
      enabled: true,
      siteAutoSyncMidnight: false,
      siteReverseSyncEnabled: false,
      siteAutoFavEnabled: false
    },
    seeded.user.id
  );
  await authRepo.upsertCredential(
    'E621',
    { username: 'e621-user', apiKey: 'stranded-key' },
    seeded.user.id
  );

  const result = await seedBooruSitesFromLegacyCredentials();
  assert.ok(result.backfilledKeys >= 1);

  const sites = await booruSitesRepo.listBooruSites(seeded.user.id);
  const e621 = sites.find((site) => site.presetKey === 'E621');
  assert.equal(e621?.apiKey, 'stranded-key');
  assert.equal(sites.length, 1, 'must fill the row in, not add another');
});

test('seedBooruSitesFromLegacyCredentials leaves a key that is already set alone', async () => {
  const seeded = await seedUser({ username: 'seed-key-already-set' });
  await booruSitesRepo.insertBooruSite(
    {
      name: 'e621',
      engine: 'e621',
      baseUrl: 'https://e621.net',
      username: 'e621-user',
      apiKey: 'site-key',
      isPreset: true,
      presetKey: 'E621',
      enabled: true,
      siteAutoSyncMidnight: false,
      siteReverseSyncEnabled: false,
      siteAutoFavEnabled: false
    },
    seeded.user.id
  );
  await authRepo.upsertCredential(
    'E621',
    { username: 'e621-user', apiKey: 'legacy-key' },
    seeded.user.id
  );

  await seedBooruSitesFromLegacyCredentials();
  const sites = await booruSitesRepo.listBooruSites(seeded.user.id);
  const e621 = sites.find((site) => site.presetKey === 'E621');
  // The site's own key wins: it is the one the user last set from the UI.
  assert.equal(e621?.apiKey, 'site-key');
});
