// /duplicates HTTP contract. The pixel-comparison algorithm lives in
// lib/duplicates.ts; running it for real needs sharp + actual images
// (covered in a separate, slower integration suite). Here we pin the
// status-machine + settings + auth wiring.
import './helpers/setupEnv';

import assert from 'node:assert/strict';

import { afterAll, beforeAll, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';

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

test('GET /duplicates/settings returns the default { autoResolve: false }', async () => {
  const seeded = await seedUser({ username: 'dup_settings_default' });
  const res = await app.inject({
    method: 'GET',
    url: '/duplicates/settings',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { autoResolve: boolean };
  assert.equal(body.autoResolve, false);
});

test('PUT /duplicates/settings persists autoResolve', async () => {
  const seeded = await seedUser({ username: 'dup_settings_set' });
  const cookie = await cookieFor(seeded.user.id);
  const put = await app.inject({
    method: 'PUT',
    url: '/duplicates/settings',
    headers: { cookie },
    payload: { autoResolve: true }
  });
  assert.equal(put.statusCode, 200);
  assert.equal((put.json() as { autoResolve: boolean }).autoResolve, true);
  const reread = await app.inject({
    method: 'GET',
    url: '/duplicates/settings',
    headers: { cookie }
  });
  assert.equal((reread.json() as { autoResolve: boolean }).autoResolve, true);
});

test('PUT /duplicates/settings rejects non-boolean autoResolve', async () => {
  const seeded = await seedUser({ username: 'dup_settings_bad' });
  const res = await app.inject({
    method: 'PUT',
    url: '/duplicates/settings',
    headers: { cookie: await cookieFor(seeded.user.id) },
    payload: { autoResolve: 'yes' }
  });
  assert.equal(res.statusCode, 400);
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
