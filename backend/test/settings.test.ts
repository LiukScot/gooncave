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
  autoVoteOnFavorite: boolean;
};

test('GET /settings/extra without cookie returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/settings/extra' });
  assert.equal(res.statusCode, 401);
});

test('GET /settings/extra defaults every extra to enabled', async () => {
  const seeded = await seedUser({ username: 'settings_defaults' });
  const res = await app.inject({
    method: 'GET',
    url: '/settings/extra',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json() as ExtraSettings, {
    gamesTabEnabled: true,
    voteSystemEnabled: true,
    autoVoteOnFavorite: true
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
    voteSystemEnabled: true,
    autoVoteOnFavorite: true
  });

  const reread = await app.inject({
    method: 'GET',
    url: '/settings/extra',
    headers: { cookie }
  });
  assert.deepEqual(reread.json() as ExtraSettings, {
    gamesTabEnabled: false,
    voteSystemEnabled: true,
    autoVoteOnFavorite: true
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

type BlacklistSettings = {
  tags: string[];
  applyToExplore: boolean;
  applyToGallery: boolean;
};

test('GET /settings/blacklist defaults to an empty list on Explore only', async () => {
  const seeded = await seedUser({ username: 'settings_blacklist_defaults' });
  const res = await app.inject({
    method: 'GET',
    url: '/settings/blacklist',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json() as BlacklistSettings, {
    tags: [],
    applyToExplore: true,
    applyToGallery: false
  });
});

test('PUT /settings/blacklist normalises, dedupes and patches partially', async () => {
  const seeded = await seedUser({ username: 'settings_blacklist_save' });
  const cookie = await cookieFor(seeded.user.id);

  const saved = await app.inject({
    method: 'PUT',
    url: '/settings/blacklist',
    headers: { cookie },
    payload: { tags: ['Gore', 'gore', 'Blue Eyes'] }
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json() as BlacklistSettings, {
    tags: ['gore', 'blue_eyes'],
    applyToExplore: true,
    applyToGallery: false
  });

  const toggled = await app.inject({
    method: 'PUT',
    url: '/settings/blacklist',
    headers: { cookie },
    payload: { applyToGallery: true }
  });
  assert.deepEqual(toggled.json() as BlacklistSettings, {
    tags: ['gore', 'blue_eyes'],
    applyToExplore: true,
    applyToGallery: true
  });
});

test('PUT /settings/blacklist rejects a non-string tag with 400', async () => {
  const seeded = await seedUser({ username: 'settings_blacklist_bad' });
  const res = await app.inject({
    method: 'PUT',
    url: '/settings/blacklist',
    headers: { cookie: await cookieFor(seeded.user.id) },
    payload: { tags: [42] }
  });
  assert.equal(res.statusCode, 400);
});

test('a blacklist row that is not valid JSON reads as the defaults', async () => {
  const seeded = await seedUser({ username: 'settings_blacklist_broken' });
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)'
    )
    .run(seeded.user.id, 'blacklist.settings', '{not json');

  const res = await app.inject({
    method: 'GET',
    url: '/settings/blacklist',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json() as BlacklistSettings, {
    tags: [],
    applyToExplore: true,
    applyToGallery: false
  });
});
