import './helpers/setupEnv';

import assert from 'node:assert/strict';

import { afterAll, beforeAll, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';

import { readMarksRepo } from '../src/db/repos/readMarksRepo';

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

test('POST /read-marks without cookie returns 401', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/read-marks',
    payload: { scope: 'file', keys: ['a'] }
  });
  assert.equal(res.statusCode, 401);
});

test('marked keys come back as read, unmarked ones do not', async () => {
  const { user } = await seedUser({ username: 'marks_roundtrip' });
  const cookie = await cookieFor(user.id);

  const res = await app.inject({
    method: 'POST',
    url: '/read-marks',
    headers: { cookie },
    payload: { scope: 'post', keys: ['site-a:1', 'site-a:2', 'site-a:1'] }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().marked, 2);

  const read = readMarksRepo.listReadKeys(user.id, 'post', [
    'site-a:1',
    'site-a:2',
    'site-a:3'
  ]);
  assert.deepEqual([...read].sort(), ['site-a:1', 'site-a:2']);
});

test('re-marking an existing key succeeds instead of colliding', async () => {
  const { user } = await seedUser({ username: 'marks_repeat' });
  const cookie = await cookieFor(user.id);
  const mark = () =>
    app.inject({
      method: 'POST',
      url: '/read-marks',
      headers: { cookie },
      payload: { scope: 'file', keys: ['file-1'] }
    });

  assert.equal((await mark()).statusCode, 200);
  assert.equal((await mark()).statusCode, 200);
  assert.equal(readMarksRepo.listReadKeys(user.id, 'file', ['file-1']).size, 1);
});

test('one scope clears without touching the other', async () => {
  const { user } = await seedUser({ username: 'marks_clear' });
  const cookie = await cookieFor(user.id);
  readMarksRepo.markRead(user.id, 'file', ['file-1']);
  readMarksRepo.markRead(user.id, 'post', ['site-a:1']);

  const res = await app.inject({
    method: 'DELETE',
    url: '/read-marks?scope=file',
    headers: { cookie }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().cleared, 1);
  assert.equal(readMarksRepo.listReadKeys(user.id, 'file', ['file-1']).size, 0);
  assert.equal(
    readMarksRepo.listReadKeys(user.id, 'post', ['site-a:1']).size,
    1
  );
});

test('one user cannot see or clear another user marks', async () => {
  const owner = await seedUser({ username: 'marks_owner' });
  const other = await seedUser({ username: 'marks_other' });
  readMarksRepo.markRead(owner.user.id, 'file', ['shared-key']);

  assert.equal(
    readMarksRepo.listReadKeys(other.user.id, 'file', ['shared-key']).size,
    0
  );

  const res = await app.inject({
    method: 'DELETE',
    url: '/read-marks?scope=file',
    headers: { cookie: await cookieFor(other.user.id) }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().cleared, 0);
  assert.equal(
    readMarksRepo.listReadKeys(owner.user.id, 'file', ['shared-key']).size,
    1
  );
});

test('POST /read-marks rejects an oversized batch and an unknown scope', async () => {
  const { user } = await seedUser({ username: 'marks_invalid' });
  const cookie = await cookieFor(user.id);

  const tooMany = await app.inject({
    method: 'POST',
    url: '/read-marks',
    headers: { cookie },
    payload: {
      scope: 'file',
      keys: Array.from({ length: 501 }, (_, index) => `file-${index}`)
    }
  });
  assert.equal(tooMany.statusCode, 400);

  const badScope = await app.inject({
    method: 'POST',
    url: '/read-marks',
    headers: { cookie },
    payload: { scope: 'folder', keys: ['x'] }
  });
  assert.equal(badScope.statusCode, 400);
});
