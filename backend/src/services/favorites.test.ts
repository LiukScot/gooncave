// Setup must run before any repo/client import resolves, because db/client
// opens SQLite at module load using config.storage.dataFile.
import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';

import { test } from 'bun:test';

import {
  buildTestApp,
  seedUser,
  writeFixtureFile,
  registerFixtureFile
} from '../../test/helpers/testApp';
import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { favoritesRepo } from '../db/repos/favoritesRepo';
import { filesRepo } from '../db/repos/filesRepo';
import { foldersRepo } from '../db/repos/foldersRepo';

import { autoFavoriteFromSauce } from './favorites';

// URL → site resolution is covered in lib/favoriteSourceMatch.test.ts via
// extractFavoriteRemoteFromSiteList. The autoFavoriteFromSauce tests below
// exercise the end-to-end favorite decision against seeded user_booru_sites.

/**
 * #66 option C guardrails — replaces the old source-text grep test with a
 * behavior-driven one. We exercise the early-return paths of
 * `autoFavoriteFromSauce` that do NOT require live HTTP, and assert each
 * skip reason fires correctly. Together they pin the contract:
 *
 *   - no-owner         → owner lookup failed
 *   - disabled         → user opted out (default in tests)
 *   - no-supported-match → no provider run with a parseable source URL
 *   - already-marked   → favorite_items row already matches, no network
 *
 * The "favorited" / "error" branches require an outbound favorite POST and
 * are covered by the integration suite (out of unit scope per AGENTS §9).
 */
test('autoFavoriteFromSauce skips when file has no owner', async () => {
  const app = await buildTestApp();
  try {
    // Build a synthetic FileRecord whose id has no corresponding user.
    const result = await autoFavoriteFromSauce({
      id: 'orphan-file-id',
      folderId: 'orphan-folder',
      locationType: 'LOCAL',
      path: '/tmp/orphan.png',
      sizeBytes: 0,
      mtime: new Date().toISOString(),
      sha256: 'x'.repeat(64),
      mediaType: 'IMAGE',
      width: null,
      height: null,
      durationMs: null,
      phash: null,
      thumbPath: null,
      voteScore: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    assert.equal(result.status, 'skipped');
    if (result.status === 'skipped') assert.equal(result.reason, 'no-owner');
  } finally {
    await app.close();
  }
});

test('autoFavoriteFromSauce skips when matched site has auto-fav disabled', async () => {
  const app = await buildTestApp();
  try {
    const seeded = await seedUser({ username: 'autofav_disabled' });
    await booruSitesRepo.insertBooruSite(
      {
        name: 'e621',
        engine: 'e621',
        baseUrl: 'https://e621.net',
        isPreset: true,
        presetKey: 'E621',
        enabled: true,
        siteAutoFavEnabled: false
      },
      seeded.user.id
    );
    const filePath = writeFixtureFile(
      seeded.libraryRoot,
      'sample.png',
      Buffer.from('x')
    );
    const folders = await foldersRepo.listFolders(seeded.user.id);
    const file = await registerFixtureFile(folders[0].id, filePath);
    const run = await filesRepo.createProviderRun(file.id, 'SAUCENAO');
    await filesRepo.updateProviderRun(run.id, {
      status: 'COMPLETED',
      score: 99,
      sourceUrl: 'https://e621.net/posts/777',
      results: [
        {
          sourceUrl: 'https://e621.net/posts/777',
          score: 99,
          sourceName: 'e621',
          thumbUrl: null
        }
      ],
      completedAt: new Date().toISOString()
    });
    const result = await autoFavoriteFromSauce(file);
    assert.equal(result.status, 'skipped');
    if (result.status === 'skipped') assert.equal(result.reason, 'disabled');
  } finally {
    await app.close();
  }
});

test('autoFavoriteFromSauce skips when no provider run yields a supported-provider URL', async () => {
  const app = await buildTestApp();
  try {
    const seeded = await seedUser({ username: 'autofav_no_match' });
    const filePath = writeFixtureFile(
      seeded.libraryRoot,
      'sample.png',
      Buffer.from('x')
    );
    const folders = await foldersRepo.listFolders(seeded.user.id);
    const file = await registerFixtureFile(folders[0].id, filePath);
    const result = await autoFavoriteFromSauce(file);
    assert.equal(result.status, 'skipped');
    if (result.status === 'skipped')
      assert.equal(result.reason, 'no-supported-match');
  } finally {
    await app.close();
  }
});

test('autoFavoriteFromSauce skips and does NOT touch network when already marked', async () => {
  const app = await buildTestApp();
  try {
    const seeded = await seedUser({ username: 'autofav_already' });

    // The URL matcher consults user_booru_sites rows now — seed the E621
    // preset so the e621.net source URL resolves to a known site. No
    // credentials needed: this test exercises the already-marked
    // short-circuit which fires before any network call.
    await booruSitesRepo.insertBooruSite(
      {
        name: 'e621',
        engine: 'e621',
        baseUrl: 'https://e621.net',
        isPreset: true,
        presetKey: 'E621',
        enabled: true,
        siteAutoFavEnabled: false
      },
      seeded.user.id
    );

    const filePath = writeFixtureFile(
      seeded.libraryRoot,
      'already.png',
      Buffer.from('x')
    );
    const folders = await foldersRepo.listFolders(seeded.user.id);
    const file = await registerFixtureFile(folders[0].id, filePath);

    // Seed a provider run with a supported e621 source above threshold.
    const run = await filesRepo.createProviderRun(file.id, 'SAUCENAO');
    await filesRepo.updateProviderRun(run.id, {
      status: 'COMPLETED',
      score: 99,
      sourceUrl: 'https://e621.net/posts/777',
      results: [
        {
          sourceUrl: 'https://e621.net/posts/777',
          score: 99,
          sourceName: 'e621',
          thumbUrl: null
        }
      ],
      completedAt: new Date().toISOString()
    });

    // Pre-mark as already-favorited locally. Provider key is 'E621' (the
    // preset key), which is what the matcher returns for preset sites so
    // legacy favorite_items rows keep matching.
    await favoritesRepo.upsertFavoriteItem(
      {
        provider: 'E621',
        remoteId: '777',
        filePath: file.path,
        sourceUrl: 'https://e621.net/posts/777',
        fileUrl: null
      },
      seeded.user.id
    );

    // If this test ever attempts a real HTTP call, the test process would
    // either hang or fail — already-marked must short-circuit before that.
    const result = await autoFavoriteFromSauce(file);
    assert.equal(result.status, 'skipped');
    if (result.status === 'skipped')
      assert.equal(result.reason, 'already-marked');
  } finally {
    await app.close();
  }
});

test('saveSauceSettings preserves omitted fields on partial updates', async () => {
  const seeded = await seedUser({ username: 'sauce_partial_update' });

  await favoritesRepo.saveSauceSettings(
    {
      display: ['E621', 'Danbooru'],
      targets: ['Artist'],
      displayInitialized: false
    },
    seeded.user.id
  );

  const updated = await favoritesRepo.saveSauceSettings(
    {
      targets: ['Source Match']
    },
    seeded.user.id
  );

  assert.deepEqual(updated.display, ['e621', 'danbooru']);
  assert.deepEqual(updated.targets, ['source match']);
  assert.equal(updated.displayInitialized, false);
});
