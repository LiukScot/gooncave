// /settings/extra HTTP contract: defaults, partial patches, and auth wiring.
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

type ExtraSettings = {
  gamesTabEnabled: boolean;
  voteSystemEnabled: boolean;
};

test('GET /settings/extra without cookie returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/settings/extra' });
  assert.equal(res.statusCode, 401);
});

test('GET /settings/extra defaults both extras to enabled', async () => {
  const seeded = await seedUser({ username: 'settings_defaults' });
  const res = await app.inject({
    method: 'GET',
    url: '/settings/extra',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json() as ExtraSettings, {
    gamesTabEnabled: true,
    voteSystemEnabled: true
  });
});

test('PUT /settings/extra applies only the keys it was given', async () => {
  const seeded = await seedUser({ username: 'settings_partial' });
  const cookie = await cookieFor(seeded.user.id);

  const off = await app.inject({
    method: 'PUT',
    url: '/settings/extra',
    headers: { cookie },
    payload: { gamesTabEnabled: false }
  });
  assert.equal(off.statusCode, 200);
  assert.deepEqual(off.json() as ExtraSettings, {
    gamesTabEnabled: false,
    voteSystemEnabled: true
  });

  const reread = await app.inject({
    method: 'GET',
    url: '/settings/extra',
    headers: { cookie }
  });
  assert.deepEqual(reread.json() as ExtraSettings, {
    gamesTabEnabled: false,
    voteSystemEnabled: true
  });
});

test('PUT /settings/extra rejects a non-boolean value with 400', async () => {
  const seeded = await seedUser({ username: 'settings_bad' });
  const res = await app.inject({
    method: 'PUT',
    url: '/settings/extra',
    headers: { cookie: await cookieFor(seeded.user.id) },
    payload: { voteSystemEnabled: 'yes' }
  });
  assert.equal(res.statusCode, 400);
});
