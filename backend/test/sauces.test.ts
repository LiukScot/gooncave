// /sauces HTTP contract. Aggregation logic lives in lib/sauces.test.ts;
// this suite checks the route wiring and settings validation.
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

test('GET /sauces without cookie returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/sauces' });
  assert.equal(res.statusCode, 401);
});

test('GET /sauces returns empty sources and zeroed progress for a fresh user', async () => {
  const seeded = await seedUser({ username: 'sauces_fresh' });
  const res = await app.inject({
    method: 'GET',
    url: '/sauces',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    sources: unknown[];
    settings: { display: string[]; targets: string[] };
    progress: { total: number; matched: number; failed: number; pending: number; videos: number };
  };
  assert.deepEqual(body.sources, []);
  assert.equal(body.progress.total, 0);
  assert.equal(body.progress.matched, 0);
  assert.equal(body.progress.pending, 0);
});

test('PUT /sauces/settings rejects invalid payload shape', async () => {
  const seeded = await seedUser({ username: 'sauces_invalid' });
  const res = await app.inject({
    method: 'PUT',
    url: '/sauces/settings',
    headers: { cookie: await cookieFor(seeded.user.id) },
    // `targets` must be array<string>. Passing a string forces a zod failure.
    payload: { targets: 'e621' }
  });
  assert.equal(res.statusCode, 400);
});

test('PUT /sauces/settings persists display and targets', async () => {
  const seeded = await seedUser({ username: 'sauces_persist' });
  const cookie = await cookieFor(seeded.user.id);
  const put = await app.inject({
    method: 'PUT',
    url: '/sauces/settings',
    headers: { cookie },
    payload: { display: ['e621', 'danbooru'], targets: ['e621'] }
  });
  assert.equal(put.statusCode, 200);
  const body = put.json() as { settings: { display: string[]; targets: string[] } };
  assert.deepEqual(body.settings.display.sort(), ['danbooru', 'e621']);
  assert.deepEqual(body.settings.targets, ['e621']);

  const reread = await app.inject({ method: 'GET', url: '/sauces', headers: { cookie } });
  const after = reread.json() as { settings: { display: string[]; targets: string[] } };
  assert.deepEqual(after.settings.targets, ['e621']);
});

test('PUT /sauces/settings of user A does not change user B settings', async () => {
  const alice = await seedUser({ username: 'sauces_iso_a' });
  const bob = await seedUser({ username: 'sauces_iso_b' });
  await app.inject({
    method: 'PUT',
    url: '/sauces/settings',
    headers: { cookie: await cookieFor(alice.user.id) },
    payload: { targets: ['e621'] }
  });
  const bobView = await app.inject({
    method: 'GET',
    url: '/sauces',
    headers: { cookie: await cookieFor(bob.user.id) }
  });
  const body = bobView.json() as { settings: { targets: string[] } };
  assert.deepEqual(body.settings.targets, []);
});
