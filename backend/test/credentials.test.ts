// HTTP shape of /credentials. Persistence semantics are pinned by
// services/credentials.test.ts; here we cover validation + ownership.
import './helpers/setupEnv';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildTestApp, seedUser, sessionCookieFor } from './helpers/testApp';

let app: FastifyInstance;

before(async () => {
  app = await buildTestApp();
});

after(async () => {
  await app.close();
});

const cookieFor = async (userId: string) => {
  const session = await sessionCookieFor(userId);
  return `${session.name}=${session.value}`;
};

test('GET /credentials without cookie returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/credentials' });
  assert.equal(res.statusCode, 401);
});

test('GET /credentials returns all three providers with source=none for a fresh user', async () => {
  const seeded = await seedUser({ username: 'cred_fresh' });
  const res = await app.inject({
    method: 'GET',
    url: '/credentials',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { credentials: Array<{ provider: string; source: string; hasApiKey: boolean }> };
  assert.deepEqual(
    body.credentials.map((c) => c.provider).sort(),
    ['DANBOORU', 'E621', 'SAUCENAO']
  );
  for (const cred of body.credentials) {
    assert.equal(cred.source, 'none');
    assert.equal(cred.hasApiKey, false);
  }
});

test('PUT /credentials rejects invalid provider with 400', async () => {
  const seeded = await seedUser({ username: 'cred_invalid_provider' });
  const res = await app.inject({
    method: 'PUT',
    url: '/credentials',
    headers: { cookie: await cookieFor(seeded.user.id) },
    payload: { provider: 'GELBOORU', username: 'x', apiKey: 'y' }
  });
  assert.equal(res.statusCode, 400);
});

test('PUT /credentials persists username/apiKey for E621', async () => {
  const seeded = await seedUser({ username: 'cred_put_ok' });
  const cookie = await cookieFor(seeded.user.id);
  const put = await app.inject({
    method: 'PUT',
    url: '/credentials',
    headers: { cookie },
    payload: { provider: 'E621', username: 'alice', apiKey: 'secret' }
  });
  assert.equal(put.statusCode, 200);
  const body = put.json() as { credential: { provider: string; username: string; hasApiKey: boolean; source: string } };
  assert.equal(body.credential.provider, 'E621');
  assert.equal(body.credential.username, 'alice');
  // The endpoint exposes hasApiKey, never the raw key — clients see only
  // presence, never the secret.
  assert.equal(body.credential.hasApiKey, true);
  assert.equal(body.credential.source, 'db');
});

test('GET /credentials never leaks the raw apiKey', async () => {
  const seeded = await seedUser({ username: 'cred_no_leak' });
  const cookie = await cookieFor(seeded.user.id);
  await app.inject({
    method: 'PUT',
    url: '/credentials',
    headers: { cookie },
    payload: { provider: 'SAUCENAO', apiKey: 'sn-secret-XYZ' }
  });
  const list = await app.inject({
    method: 'GET',
    url: '/credentials',
    headers: { cookie }
  });
  const body = list.json();
  // The serializer in routes/credentials.ts must NOT include `apiKey` —
  // only `hasApiKey`. This catches a serializer regression that would
  // ship secrets to the SPA.
  assert.equal(JSON.stringify(body).includes('sn-secret-XYZ'), false);
});

test('GET /credentials of user A does NOT show user B credentials', async () => {
  const alice = await seedUser({ username: 'cred_isolation_a' });
  const bob = await seedUser({ username: 'cred_isolation_b' });
  const aliceCookie = await cookieFor(alice.user.id);
  const bobCookie = await cookieFor(bob.user.id);
  await app.inject({
    method: 'PUT',
    url: '/credentials',
    headers: { cookie: aliceCookie },
    payload: { provider: 'E621', username: 'alice', apiKey: 'A' }
  });
  const bobView = await app.inject({
    method: 'GET',
    url: '/credentials',
    headers: { cookie: bobCookie }
  });
  const body = bobView.json() as { credentials: Array<{ provider: string; username: string | null; source: string }> };
  const bobE621 = body.credentials.find((c) => c.provider === 'E621');
  assert.ok(bobE621);
  assert.equal(bobE621?.username, null);
  assert.equal(bobE621?.source, 'none');
});

test('PUT /credentials upserts (second call overwrites the first)', async () => {
  const seeded = await seedUser({ username: 'cred_upsert' });
  const cookie = await cookieFor(seeded.user.id);
  await app.inject({
    method: 'PUT',
    url: '/credentials',
    headers: { cookie },
    payload: { provider: 'DANBOORU', username: 'first', apiKey: 'K1' }
  });
  const second = await app.inject({
    method: 'PUT',
    url: '/credentials',
    headers: { cookie },
    payload: { provider: 'DANBOORU', username: 'second', apiKey: 'K2' }
  });
  const body = second.json() as { credential: { username: string } };
  assert.equal(body.credential.username, 'second');
});

test('PUT /credentials with empty body returns 400', async () => {
  const seeded = await seedUser({ username: 'cred_empty_body' });
  const res = await app.inject({
    method: 'PUT',
    url: '/credentials',
    headers: { cookie: await cookieFor(seeded.user.id) },
    payload: {}
  });
  assert.equal(res.statusCode, 400);
});
