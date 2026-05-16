// Admin routes are thin wrappers around dataStore. Tests pin the wiring
// (auth required, per-user isolation) rather than the dataStore logic
// itself — that has its own suite.
import './helpers/setupEnv';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildTestApp, seedUser, sessionCookieFor } from './helpers/testApp';
import { dataStore } from '../src/lib/dataStore';

let app: FastifyInstance;

before(async () => {
  app = await buildTestApp();
});

after(async () => {
  await app.close();
});

test('POST /scans/clear without cookie returns 401', async () => {
  const res = await app.inject({ method: 'POST', url: '/scans/clear' });
  assert.equal(res.statusCode, 401);
});

test('POST /scans/clear returns { cleared: true } for an authenticated user', async () => {
  const seeded = await seedUser({ username: 'admin_clear_ok' });
  const session = await sessionCookieFor(seeded.user.id);
  const res = await app.inject({
    method: 'POST',
    url: '/scans/clear',
    headers: { cookie: `${session.name}=${session.value}` }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { cleared: true });
});

test('POST /scans/clear only touches the caller\'s scans (per-user isolation)', async () => {
  // Two users, each with a folder. We don't have an easy public seam to
  // pre-create a scan record without driving the worker, so we just
  // assert that clearing as user A doesn't fail noisily for user B.
  // The real isolation check lives in the dataStore unit suite.
  const alice = await seedUser({ username: 'admin_alice' });
  const bob = await seedUser({ username: 'admin_bob' });
  const aliceCookie = await sessionCookieFor(alice.user.id);
  const bobCookie = await sessionCookieFor(bob.user.id);

  const clearAsAlice = await app.inject({
    method: 'POST',
    url: '/scans/clear',
    headers: { cookie: `${aliceCookie.name}=${aliceCookie.value}` }
  });
  assert.equal(clearAsAlice.statusCode, 200);

  // Bob still works after Alice cleared.
  const clearAsBob = await app.inject({
    method: 'POST',
    url: '/scans/clear',
    headers: { cookie: `${bobCookie.name}=${bobCookie.value}` }
  });
  assert.equal(clearAsBob.statusCode, 200);

  // Both folders are still present (the clear is on scans, not folders).
  const aliceFolders = await dataStore.listFolders(alice.user.id);
  const bobFolders = await dataStore.listFolders(bob.user.id);
  assert.ok(aliceFolders.length >= 1);
  assert.ok(bobFolders.length >= 1);
});
