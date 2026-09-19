// /duplicates HTTP contract. The pixel-comparison algorithm lives in
// lib/duplicates.ts; running it for real needs sharp + actual images
// (covered in a separate, slower integration suite). Here we pin the
// status-machine + settings + auth wiring.
import './helpers/setupEnv';

import assert from 'node:assert/strict';

import { afterAll, beforeAll, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
// sharp's callable API is its default export; the package also exposes named utilities.
// eslint-disable-next-line import-x/no-named-as-default
import sharp from 'sharp';

import { booruSitesRepo } from '../src/db/repos/booruSitesRepo';
import { duplicatePolicyRepo } from '../src/db/repos/duplicatePolicyRepo';
import { favoritesRepo } from '../src/db/repos/favoritesRepo';
import { getSignaturesBatch, setSignature } from '../src/db/repos/files/signatures';
import { filesRepo } from '../src/db/repos/filesRepo';
import { foldersRepo } from '../src/db/repos/foldersRepo';
import { findDuplicates } from '../src/lib/duplicates';

import {
  buildTestApp,
  registerFixtureFile,
  seedUser,
  sessionCookieFor,
  writeFixtureFile
} from './helpers/testApp';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

const cookieFor = async (userId: string) => {
  const session = await sessionCookieFor(userId);
  return `${session.name}=${session.value}`;
};

test('POST /duplicates/scan/start without cookie returns 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/duplicates/scan/start'
  });
  assert.equal(res.statusCode, 401);
});

test('POST /duplicates/scan/start rejects out-of-range pixelThreshold', async () => {
  const seeded = await seedUser({ username: 'dup_bad_threshold' });
  const res = await app.inject({
    method: 'POST',
    url: '/duplicates/scan/start',
    headers: { cookie: await cookieFor(seeded.user.id) },
    payload: { pixelThreshold: 2 } // valid range is 0..1
  });
  assert.equal(res.statusCode, 400);
});

test('POST /duplicates/scan/start kicks off a scan and returns status:started', async () => {
  const seeded = await seedUser({ username: 'dup_start_ok' });
  const res = await app.inject({
    method: 'POST',
    url: '/duplicates/scan/start',
    headers: { cookie: await cookieFor(seeded.user.id) },
    payload: {}
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { status: string; state: { status: string } };
  assert.ok(['started', 'busy'].includes(body.status));
  assert.ok(['running', 'done', 'idle'].includes(body.state.status));
});

test('automatic scan limits do not block a manual scan', async () => {
  const seeded = await seedUser({ username: 'dup_scan_intents' });
  const cookie = await cookieFor(seeded.user.id);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const automatic = await app.inject({
      method: 'POST',
      url: '/duplicates/scan/start',
      headers: { cookie, 'x-duplicate-scan-intent': 'automatic' },
      payload: {}
    });
    assert.equal(automatic.statusCode, 200);
  }
  const manual = await app.inject({
    method: 'POST',
    url: '/duplicates/scan/start',
    headers: { cookie, 'x-duplicate-scan-intent': 'manual' },
    payload: {}
  });
  assert.equal(manual.statusCode, 200);
});

test('GET /duplicates/scan/status returns idle for a fresh user', async () => {
  const seeded = await seedUser({ username: 'dup_status_fresh' });
  const res = await app.inject({
    method: 'GET',
    url: '/duplicates/scan/status',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    status: string;
    progress: unknown;
    result: unknown;
  };
  assert.equal(body.status, 'idle');
  assert.equal(body.progress, null);
  assert.equal(body.result, null);
});

test('POST /duplicates/scan/cancel returns idle when nothing is running', async () => {
  const seeded = await seedUser({ username: 'dup_cancel_idle' });
  const res = await app.inject({
    method: 'POST',
    url: '/duplicates/scan/cancel',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { status: string };
  assert.equal(body.status, 'idle');
});

test('findDuplicates returns empty groups for an empty library', async () => {
  const seeded = await seedUser({ username: 'dup_sync_empty' });
  const result = await findDuplicates(seeded.user.id);
  assert.deepEqual(result.groups, []);
  assert.equal(result.stats.totalFiles, 0);
  assert.equal(result.stats.eligibleFiles, 0);
});

test('cached video signatures are returned as readable Buffers', async () => {
  const seeded = await seedUser({ username: 'dup_cached_video' });
  const folder = (await foldersRepo.listFolders(seeded.user.id))[0];
  const file = await registerFixtureFile(
    folder.id,
    writeFixtureFile(seeded.libraryRoot, 'cached-video.mp4', 'video'),
    { mediaType: 'VIDEO' }
  );
  const data = Buffer.alloc(4);
  data.writeUInt32LE(1, 0);
  setSignature(file.id, 'VIDEO', 96, data, file.sha256);

  const cached = getSignaturesBatch([file.id], 96).get(file.id);
  assert.ok(cached);
  assert.equal(cached.data.readUInt32LE(0), 1);
});

test('duplicate scan names the favorite source for each local copy', async () => {
  const seeded = await seedUser({ username: 'dup_source_names' });
  const site = await booruSitesRepo.insertBooruSite({
    name: 'Danbooru',
    engine: 'danbooru',
    baseUrl: 'https://danbooru.donmai.us',
    isPreset: false,
    enabled: true
  }, seeded.user.id);
  const folder = (await foldersRepo.listFolders(seeded.user.id))[0];
  const image = await sharp({ create: {
    width: 16, height: 16, channels: 3, background: '#445566'
  } }).png().toBuffer();
  const first = await registerFixtureFile(folder.id, writeFixtureFile(seeded.libraryRoot, 'one.png', image), { width: 16, height: 16 });
  const second = await registerFixtureFile(folder.id, writeFixtureFile(seeded.libraryRoot, 'two.png', image), { width: 16, height: 16 });
  await favoritesRepo.upsertFavoriteItem({
    provider: site.id,
    remoteId: '1',
    filePath: first.path
  }, seeded.user.id);

  const result = await findDuplicates(seeded.user.id);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].files.find((file) => file.id === first.id)?.favoriteProviders, [site.id]);
  assert.deepEqual(result.groups[0].files.find((file) => file.id === second.id)?.favoriteProviders, []);
});

test('duplicate candidates are grouped in SQLite and isolated by user', async () => {
  const owner = await seedUser({ username: 'dup_candidates_owner' });
  const other = await seedUser({ username: 'dup_candidates_other' });
  const ownerFolder = (await foldersRepo.listFolders(owner.user.id))[0];
  const otherFolder = (await foldersRepo.listFolders(other.user.id))[0];

  await registerFixtureFile(
    ownerFolder.id,
    writeFixtureFile(owner.libraryRoot, 'same-a.png', 'a'),
    { width: 640, height: 480 }
  );
  await registerFixtureFile(
    ownerFolder.id,
    writeFixtureFile(owner.libraryRoot, 'same-b.png', 'bb'),
    { width: 640, height: 480 }
  );
  await registerFixtureFile(
    ownerFolder.id,
    writeFixtureFile(owner.libraryRoot, 'single.png', 'ccc'),
    { width: 800, height: 600 }
  );
  await registerFixtureFile(
    otherFolder.id,
    writeFixtureFile(other.libraryRoot, 'other.png', 'dddd'),
    { width: 640, height: 480 }
  );

  const summary = filesRepo.describeDuplicateCandidates(owner.user.id);
  assert.equal(summary.totalFiles, 3);
  assert.equal(summary.eligibleFiles, 3);
  assert.deepEqual(summary.groups, [
    { mediaType: 'IMAGE', width: 640, height: 480, count: 2 }
  ]);

  const files = filesRepo.listDuplicateCandidateGroup(
    owner.user.id,
    summary.groups[0]
  );
  assert.deepEqual(
    files.map((file) => file.path).sort(),
    [
      `${owner.libraryRoot}/same-a.png`,
      `${owner.libraryRoot}/same-b.png`
    ]
  );
});

test('GET /duplicates/settings returns disabled policy and no unconfigured sources', async () => {
  const seeded = await seedUser({ username: 'dup_settings_default' });
  const res = await app.inject({
    method: 'GET',
    url: '/duplicates/settings',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { enabled: boolean; style: string | null; preferredProviders: string[] };
  assert.equal(body.enabled, false);
  assert.equal(body.style, null);
  assert.deepEqual(body.preferredProviders, []);
});

test('policy preview accepts configured sites and rejects duplicates or foreign sites', async () => {
  const owner = await seedUser({ username: 'dup_priority_owner' });
  const other = await seedUser({ username: 'dup_priority_other' });
  const first = await booruSitesRepo.insertBooruSite({
    name: 'e621', engine: 'e621', baseUrl: 'https://e621.net',
    isPreset: true, presetKey: 'E621', enabled: true
  }, owner.user.id);
  const second = await booruSitesRepo.insertBooruSite({
    name: 'Custom', engine: 'szurubooru', baseUrl: 'https://custom.example',
    isPreset: false, presetKey: null, enabled: true
  }, owner.user.id);
  const cookie = await cookieFor(owner.user.id);
  const initial = await app.inject({ method: 'GET', url: '/duplicates/settings', headers: { cookie } });
  assert.deepEqual(initial.json().preferredProviders, ['E621', second.id]);

  const selected = await app.inject({
    method: 'POST', url: '/duplicates/policy/preview', headers: { cookie },
    payload: { style: 'preferred_only', preferredProviders: [second.id] }
  });
  assert.equal(selected.statusCode, 200);
  assert.deepEqual(selected.json().preferredProviders, [second.id]);

  const reread = await app.inject({ method: 'GET', url: '/duplicates/settings', headers: { cookie } });
  assert.deepEqual(reread.json().preferredProviders, ['E621', second.id]);
  const third = await booruSitesRepo.insertBooruSite({
    name: 'Another', engine: 'szurubooru', baseUrl: 'https://another.example',
    isPreset: false, presetKey: null, enabled: true
  }, owner.user.id);
  const withNewSite = await app.inject({ method: 'GET', url: '/duplicates/settings', headers: { cookie } });
  assert.deepEqual(withNewSite.json().preferredProviders, [
    'E621',
    second.id,
    third.id
  ]);
  const ownerOnly = await app.inject({
    method: 'GET', url: '/duplicates/settings',
    headers: { cookie: await cookieFor(other.user.id) }
  });
  assert.deepEqual(ownerOnly.json().preferredProviders, []);

  for (const preferredProviders of [['E621', 'E621'], [first.id], ['foreign-site']]) {
    const invalid = await app.inject({
      method: 'POST', url: '/duplicates/policy/preview', headers: { cookie },
      payload: { style: 'preferred_only', preferredProviders }
    });
    assert.equal(invalid.statusCode, 400);
  }
});

test('PUT /duplicates/settings only disables an existing policy', async () => {
  const seeded = await seedUser({ username: 'dup_settings_set' });
  const cookie = await cookieFor(seeded.user.id);
  await favoritesRepo.saveDuplicateSettings(
    { enabled: true, style: 'favorite_all' },
    seeded.user.id
  );
  const put = await app.inject({
    method: 'PUT',
    url: '/duplicates/settings',
    headers: { cookie },
    payload: { enabled: false }
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().enabled, false);
  assert.equal(put.json().style, 'favorite_all');
  const reread = await app.inject({
    method: 'GET',
    url: '/duplicates/settings',
    headers: { cookie }
  });
  assert.equal(reread.json().enabled, false);
  assert.equal(reread.json().style, 'favorite_all');
});

test('PUT /duplicates/settings rejects activation and strategy changes', async () => {
  const seeded = await seedUser({ username: 'dup_settings_bad' });
  const res = await app.inject({
    method: 'PUT',
    url: '/duplicates/settings',
    headers: { cookie: await cookieFor(seeded.user.id) },
    payload: { enabled: true, style: 'preferred_only', preferredProviders: [] }
  });
  assert.equal(res.statusCode, 400);
  const styleOnly = await app.inject({
    method: 'PUT',
    url: '/duplicates/settings',
    headers: { cookie: await cookieFor(seeded.user.id) },
    payload: { style: 'favorite_all' }
  });
  assert.equal(styleOnly.statusCode, 400);
});

test('duplicate policy preview is non-mutating and confirmation enables it', async () => {
  const seeded = await seedUser({ username: 'dup_policy_preview' });
  const cookie = await cookieFor(seeded.user.id);
  const previewResponse = await app.inject({
    method: 'POST',
    url: '/duplicates/policy/preview',
    headers: { cookie },
    payload: { style: 'favorite_all', preferredProviders: [] }
  });
  assert.equal(previewResponse.statusCode, 200);
  const preview = previewResponse.json();
  assert.equal(preview.kind, 'preview');
  assert.equal(preview.status, 'ready');
  assert.equal(preview.totalGroups, 0);
  assert.deepEqual(preview.actions, []);

  const beforeConfirm = await app.inject({
    method: 'GET',
    url: '/duplicates/settings',
    headers: { cookie }
  });
  assert.equal(beforeConfirm.json().enabled, false);

  const confirm = await app.inject({
    method: 'POST',
    url: '/duplicates/policy/confirm',
    headers: { cookie },
    payload: { previewId: preview.id }
  });
  assert.equal(confirm.statusCode, 200);
  assert.equal(confirm.json().kind, 'apply');

  const afterConfirm = await app.inject({
    method: 'GET',
    url: '/duplicates/settings',
    headers: { cookie }
  });
  assert.equal(afterConfirm.json().enabled, true);
  assert.equal(afterConfirm.json().style, 'favorite_all');
});

test('duplicate policy preview rejects preferred-only without providers', async () => {
  const seeded = await seedUser({ username: 'dup_policy_empty_allowlist' });
  const response = await app.inject({
    method: 'POST',
    url: '/duplicates/policy/preview',
    headers: { cookie: await cookieFor(seeded.user.id) },
    payload: { style: 'preferred_only', preferredProviders: [] }
  });
  assert.equal(response.statusCode, 400);
});

test('duplicate policy actions retain their safety order', async () => {
  const seeded = await seedUser({ username: 'dup_policy_order' });
  const runId = duplicatePolicyRepo.createRun({
    userId: seeded.user.id,
    kind: 'preview',
    style: 'preferred_only',
    preferredProviders: ['E621'],
    reason: 'test'
  });
  const action = (
    kind: 'confirm_favorite' | 'remove_favorite' | 'delete_file',
    message: string
  ) => ({
    groupKey: 'group',
    kind,
    provider: kind === 'delete_file' ? null : 'E621',
    remoteId: kind === 'delete_file' ? null : '1',
    fileId: kind === 'delete_file' ? 'file-1' : null,
    fileName: kind === 'delete_file' ? 'copy.jpg' : null,
    message
  });
  duplicatePolicyRepo.addActions(runId, [
    action('confirm_favorite', 'confirm'),
    action('remove_favorite', 'remove'),
    action('delete_file', 'delete')
  ]);

  assert.deepEqual(
    duplicatePolicyRepo.getRun(runId, seeded.user.id)?.actions.map(
      (item) => item.message
    ),
    ['confirm', 'remove', 'delete']
  );
});

test('GET /duplicates/scan/status of user A does not show user B state', async () => {
  const alice = await seedUser({ username: 'dup_iso_a' });
  const bob = await seedUser({ username: 'dup_iso_b' });
  await app.inject({
    method: 'POST',
    url: '/duplicates/scan/start',
    headers: { cookie: await cookieFor(alice.user.id) },
    payload: {}
  });
  const bobStatus = await app.inject({
    method: 'GET',
    url: '/duplicates/scan/status',
    headers: { cookie: await cookieFor(bob.user.id) }
  });
  const body = bobStatus.json() as { status: string };
  // Bob never started a scan; even though Alice's runs in the same
  // process, status must be per-user.
  assert.equal(body.status, 'idle');
});
