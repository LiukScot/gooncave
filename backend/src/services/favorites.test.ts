// Setup must run before any repo/client import resolves, because db/client
// opens SQLite at module load using config.storage.dataFile.
import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';
import fs from 'node:fs';

import { afterEach, test } from 'bun:test';

import {
  disarmFetchMock,
  setupFetchMock
} from '../../test/helpers/fetchMock';
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
import { ENGINE_REGISTRY } from '../lib/booruEngines';

import {
  autoFavoriteFromSauce,
  cancelFavoritesSync,
  getFavoritesSyncStatus,
  startFavoritesSync
} from './favorites';

const ONE_BY_ONE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cf' +
    'c0c00000000300017c6bf3060000000049454e44ae426082',
  'hex'
);

afterEach(disarmFetchMock);

const waitForFavoritesSync = async (userId: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = getFavoritesSyncStatus(userId);
    if (state.status !== 'running') return state;
    await Bun.sleep(10);
  }
  throw new Error('Favorites sync did not finish');
};

test('favorites downloads are bounded, deduplicated, and counted after out-of-order completion', async () => {
  const app = await buildTestApp();
  const originalEngine = ENGINE_REGISTRY.furaffinity;
  const previousAllowPrivate = process.env.ALLOW_PRIVATE_BOORU_HOSTS;
  let active = 0;
  let maxActive = 0;
  let requests = 0;
  try {
    process.env.ALLOW_PRIVATE_BOORU_HOSTS = 'true';
    const fetchMock = setupFetchMock();
    const seeded = await seedUser({ username: 'favorites_concurrency' });
    const site = await booruSitesRepo.insertBooruSite(
      {
        name: 'Concurrent FurAffinity',
        engine: 'furaffinity',
        baseUrl: 'https://www.furaffinity.net',
        username: 'demo',
        sessionCookie: 'a=account; b=session',
        enabled: true
      },
      seeded.user.id
    );
    const items = Array.from({ length: 6 }, (_, index) => ({
      provider: site.id,
      remoteId: String(index + 1),
      sourceUrl: `https://www.furaffinity.net/view/${index + 1}/`,
      fileUrl: `https://cdn.example/${index + 1}.png`
    }));
    for (const item of items) {
      fetchMock.intercept(
        (url) => url === item.fileUrl,
        {
          status: 200,
          body: ONE_BY_ONE_PNG,
          headers: { 'Content-Type': 'image/png' },
          delayMs: item.remoteId === '1' ? 60 : 5,
          onStart: () => {
            requests += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
          },
          onFinish: () => {
            active -= 1;
          }
        }
      );
    }
    ENGINE_REGISTRY.furaffinity = {
      ...originalEngine,
      fetchPostDetails: undefined,
      fetchPostTags: async () => [],
      fetchFavorites: async (_site, context) => {
        for (const item of [...items, items[0]]) {
          await context?.onFavoriteResolved?.(item, {}, items.length);
        }
        return { items: [...items, items[0]], downloadHeaders: {} };
      }
    };

    assert.equal(startFavoritesSync(seeded.user.id).status, 'started');
    const state = await waitForFavoritesSync(seeded.user.id);
    assert.equal(state.status, 'done');
    assert.equal(state.results[0].fetched, 6);
    assert.equal(state.results[0].added, 6);
    assert.equal(state.results[0].skipped, 0);
    assert.equal(state.results[0].errors.length, 0);
    assert.equal(requests, 6);
    assert.ok(maxActive > 1);
    assert.ok(maxActive <= 4);
  } finally {
    ENGINE_REGISTRY.furaffinity = originalEngine;
    if (previousAllowPrivate === undefined) {
      delete process.env.ALLOW_PRIVATE_BOORU_HOSTS;
    } else {
      process.env.ALLOW_PRIVATE_BOORU_HOSTS = previousAllowPrivate;
    }
    await app.close();
  }
});

test('cancelling favorites stops queued downloads and removes partial files', async () => {
  const app = await buildTestApp();
  const originalEngine = ENGINE_REGISTRY.furaffinity;
  const previousAllowPrivate = process.env.ALLOW_PRIVATE_BOORU_HOSTS;
  let requests = 0;
  let markPoolFull = () => {};
  const poolFull = new Promise<void>((resolve) => {
    markPoolFull = resolve;
  });
  try {
    process.env.ALLOW_PRIVATE_BOORU_HOSTS = 'true';
    const fetchMock = setupFetchMock();
    const seeded = await seedUser({ username: 'favorites_cancel_queued' });
    const site = await booruSitesRepo.insertBooruSite(
      {
        name: 'Cancellable FurAffinity',
        engine: 'furaffinity',
        baseUrl: 'https://www.furaffinity.net',
        username: 'demo',
        sessionCookie: 'a=account; b=session',
        enabled: true
      },
      seeded.user.id
    );
    const items = Array.from({ length: 8 }, (_, index) => ({
      provider: site.id,
      remoteId: String(index + 1),
      sourceUrl: `https://www.furaffinity.net/view/${index + 1}/`,
      fileUrl: `https://slow.example/${index + 1}.png`
    }));
    for (const item of items) {
      fetchMock.intercept((url) => url === item.fileUrl, {
        status: 200,
        body: ONE_BY_ONE_PNG,
        delayMs: 500,
        onStart: () => {
          requests += 1;
          if (requests === 4) markPoolFull();
        }
      });
    }
    ENGINE_REGISTRY.furaffinity = {
      ...originalEngine,
      fetchPostDetails: undefined,
      fetchPostTags: async () => [],
      fetchFavorites: async (_site, context) => {
        for (const item of items) {
          await context?.onFavoriteResolved?.(item, {}, items.length);
        }
        return { items, downloadHeaders: {} };
      }
    };

    assert.equal(startFavoritesSync(seeded.user.id).status, 'started');
    await poolFull;
    assert.equal(cancelFavoritesSync(seeded.user.id).status, 'cancelling');
    const state = await waitForFavoritesSync(seeded.user.id);
    assert.equal(state.message, 'Favorites sync cancelled.');
    assert.equal(requests, 4);
    const leftovers = (await fs.promises.readdir(seeded.libraryRoot)).filter(
      (name) => name.endsWith('.part')
    );
    assert.deepEqual(leftovers, []);
  } finally {
    ENGINE_REGISTRY.furaffinity = originalEngine;
    if (previousAllowPrivate === undefined) {
      delete process.env.ALLOW_PRIVATE_BOORU_HOSTS;
    } else {
      process.env.ALLOW_PRIVATE_BOORU_HOSTS = previousAllowPrivate;
    }
    await app.close();
  }
});

// URL → site resolution is covered in lib/favoriteSourceMatch.test.ts via
// extractFavoriteRemoteFromSiteList. The autoFavoriteFromSauce tests below
// exercise the end-to-end favorite decision against seeded user_booru_sites.

test('cancelFavoritesSync interrupts a running engine and releases the job', async () => {
  const app = await buildTestApp();
  const originalEngine = ENGINE_REGISTRY.furaffinity;
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  try {
    const seeded = await seedUser({ username: 'favorites_cancel' });
    await booruSitesRepo.insertBooruSite(
      {
        name: 'FurAffinity',
        engine: 'furaffinity',
        baseUrl: 'https://www.furaffinity.net',
        username: 'demo',
        sessionCookie: 'a=account; b=session',
        enabled: true
      },
      seeded.user.id
    );
    ENGINE_REGISTRY.furaffinity = {
      ...originalEngine,
      fetchFavorites: (_site, context) =>
        new Promise((_resolve, reject) => {
          markStarted();
          context?.signal?.addEventListener(
            'abort',
            () => reject(new Error('Favorites fetch aborted')),
            { once: true }
          );
        })
    };

    assert.equal(startFavoritesSync(seeded.user.id).status, 'started');
    await started;
    assert.equal(cancelFavoritesSync(seeded.user.id).status, 'cancelling');

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (getFavoritesSyncStatus(seeded.user.id).status !== 'running') break;
      await Bun.sleep(5);
    }
    const status = getFavoritesSyncStatus(seeded.user.id);
    assert.equal(status.status, 'done');
    assert.equal(status.message, 'Favorites sync cancelled.');
    assert.equal(startFavoritesSync(seeded.user.id).status, 'started');
    assert.equal(cancelFavoritesSync(seeded.user.id).status, 'cancelling');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (getFavoritesSyncStatus(seeded.user.id).status !== 'running') break;
      await Bun.sleep(5);
    }
  } finally {
    ENGINE_REGISTRY.furaffinity = originalEngine;
    await app.close();
  }
});

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
