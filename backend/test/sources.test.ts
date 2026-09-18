// /sources HTTP contract. Aggregation logic lives in lib/sources.test.ts;
// this suite checks the route wiring and settings validation.
import './helpers/setupEnv';

import assert from 'node:assert/strict';

import { afterAll, beforeAll, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';

import { buildTestApp, seedUser, sessionCookieFor } from './helpers/testApp';

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

test('GET /sources without cookie returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/sources' });
  assert.equal(res.statusCode, 401);
});

test('GET /sources returns empty sources and zeroed progress for a fresh user', async () => {
  const seeded = await seedUser({ username: 'sources_fresh' });
  const res = await app.inject({
    method: 'GET',
    url: '/sources',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    sources: unknown[];
    settings: { display: string[]; targets: string[] };
    progress: {
      total: number;
      matched: number;
      failed: number;
      pending: number;
      videos: number;
    };
  };
  assert.deepEqual(body.sources, []);
  assert.equal(body.progress.total, 0);
  assert.equal(body.progress.matched, 0);
  assert.equal(body.progress.pending, 0);
});

test('PUT /sources/settings rejects invalid payload shape', async () => {
  const seeded = await seedUser({ username: 'sources_invalid' });
  const res = await app.inject({
    method: 'PUT',
    url: '/sources/settings',
    headers: { cookie: await cookieFor(seeded.user.id) },
    // `targets` must be array<string>. Passing a string forces a zod failure.
    payload: { targets: 'e621' }
  });
  assert.equal(res.statusCode, 400);
});

test('PUT /sources/settings persists display and targets', async () => {
  const seeded = await seedUser({ username: 'sources_persist' });
  const cookie = await cookieFor(seeded.user.id);
  const put = await app.inject({
    method: 'PUT',
    url: '/sources/settings',
    headers: { cookie },
    payload: { display: ['e621', 'danbooru'], targets: ['e621'] }
  });
  assert.equal(put.statusCode, 200);
  const body = put.json() as {
    settings: { display: string[]; targets: string[] };
  };
  assert.deepEqual(body.settings.display.sort(), ['danbooru', 'e621']);
  assert.deepEqual(body.settings.targets, ['e621']);

  const reread = await app.inject({
    method: 'GET',
    url: '/sources',
    headers: { cookie }
  });
  const after = reread.json() as {
    settings: { display: string[]; targets: string[] };
  };
  assert.deepEqual(after.settings.targets, ['e621']);
});

test('PUT /sources/settings of user A does not change user B settings', async () => {
  const alice = await seedUser({ username: 'sources_iso_a' });
  const bob = await seedUser({ username: 'sources_iso_b' });
  await app.inject({
    method: 'PUT',
    url: '/sources/settings',
    headers: { cookie: await cookieFor(alice.user.id) },
    payload: { targets: ['e621'] }
  });
  const bobView = await app.inject({
    method: 'GET',
    url: '/sources',
    headers: { cookie: await cookieFor(bob.user.id) }
  });
  const body = bobView.json() as { settings: { targets: string[] } };
  assert.deepEqual(body.settings.targets, []);
});
