// /settings HTTP contract: defaults, partial patches, auth wiring, and the
// per-user key bindings.
import './helpers/setupEnv';

import assert from 'node:assert/strict';

import { afterAll, beforeAll, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';

import { sqlite } from '../src/db/client';

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

test('shortcuts round-trip and default to nothing stored', async () => {
  const seeded = await seedUser({ username: 'settings_shortcuts' });
  const cookie = await cookieFor(seeded.user.id);

  const empty = await app.inject({
    method: 'GET',
    url: '/settings/shortcuts',
    headers: { cookie }
  });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual((empty.json() as { bindings: unknown }).bindings, {});

  const saved = await app.inject({
    method: 'PUT',
    url: '/settings/shortcuts',
    headers: { cookie },
    payload: { bindings: { prev: 'a', voteUp: '+' } }
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual((saved.json() as { bindings: unknown }).bindings, {
    prev: 'a',
    voteUp: '+'
  });

  const read = await app.inject({
    method: 'GET',
    url: '/settings/shortcuts',
    headers: { cookie }
  });
  assert.deepEqual((read.json() as { bindings: unknown }).bindings, {
    prev: 'a',
    voteUp: '+'
  });
});

test('shortcuts of one user never reach another', async () => {
  const mine = await seedUser({ username: 'settings_shortcuts_mine' });
  const theirs = await seedUser({ username: 'settings_shortcuts_theirs' });
  await app.inject({
    method: 'PUT',
    url: '/settings/shortcuts',
    headers: { cookie: await cookieFor(mine.user.id) },
    payload: { bindings: { prev: 'z' } }
  });

  const read = await app.inject({
    method: 'GET',
    url: '/settings/shortcuts',
    headers: { cookie: await cookieFor(theirs.user.id) }
  });
  assert.deepEqual((read.json() as { bindings: unknown }).bindings, {});
});

test('a shortcuts row that is not valid JSON reads as empty', async () => {
  const seeded = await seedUser({ username: 'settings_shortcuts_broken' });
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)'
    )
    .run(seeded.user.id, 'shortcuts.bindings', '{not json');

  const res = await app.inject({
    method: 'GET',
    url: '/settings/shortcuts',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { bindings: unknown }).bindings, {});
});
