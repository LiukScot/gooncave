// Seeds existing provider_credentials E621/DANBOORU rows into user_booru_sites
// preset rows on boot. Pin the idempotency contract: running twice must not
// duplicate, and existing preset rows must be left alone.
import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';
import { test } from 'node:test';

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
