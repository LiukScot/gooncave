// /folders HTTP contract. The auto-managed-folder ensure path is the
// most failure-prone bit; we exercise it via real GETs and POSTs.
import './helpers/setupEnv';

import fs from 'fs';
import path from 'path';
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

test('GET /folders without cookie returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/folders' });
  assert.equal(res.statusCode, 401);
});

test('GET /folders returns at least the user library root for a fresh user', async () => {
  const seeded = await seedUser({ username: 'folders_fresh' });
  const res = await app.inject({
    method: 'GET',
    url: '/folders',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { folders: Array<{ id: string; path: string; type: string }> };
  assert.ok(body.folders.length >= 1);
  assert.ok(body.folders.some((f) => path.resolve(f.path) === path.resolve(seeded.libraryRoot)));
});

test('GET /folders auto-registers a direct child subdirectory created on disk', async () => {
  const seeded = await seedUser({ username: 'folders_auto_child' });
  const cookie = await cookieFor(seeded.user.id);
  const child = path.join(seeded.libraryRoot, 'pics');
  await fs.promises.mkdir(child, { recursive: true });
  const res = await app.inject({ method: 'GET', url: '/folders', headers: { cookie } });
  const body = res.json() as { folders: Array<{ path: string }> };
  assert.ok(body.folders.some((f) => path.resolve(f.path) === path.resolve(child)),
    'expected /folders to auto-register direct child folder');
});

test('POST /folders without cookie returns 401', async () => {
  const res = await app.inject({ method: 'POST', url: '/folders', payload: { path: '/tmp/whatever' } });
  assert.equal(res.statusCode, 401);
});

test('POST /folders with empty path returns 400', async () => {
  const seeded = await seedUser({ username: 'folders_empty_path' });
  const res = await app.inject({
    method: 'POST',
    url: '/folders',
    headers: { cookie: await cookieFor(seeded.user.id) },
    payload: { path: '' }
  });
  assert.equal(res.statusCode, 400);
});

test('POST /folders rejects a path outside the user library root', async () => {
  const seeded = await seedUser({ username: 'folders_escape' });
  const res = await app.inject({
    method: 'POST',
    url: '/folders',
    headers: { cookie: await cookieFor(seeded.user.id) },
    payload: { path: '/etc' }
  });
  assert.equal(res.statusCode, 400);
  const body = res.json() as { error: string };
  // Surface a user-friendly reason. The exact wording lives in the route
  // handler; we just require *some* mention of "library root".
  assert.match(body.error, /library root/i);
});

test('POST /folders inside the library root creates a new folder record', async () => {
  const seeded = await seedUser({ username: 'folders_create' });
  const cookie = await cookieFor(seeded.user.id);
  const newPath = path.join(seeded.libraryRoot, 'collection-a');
  await fs.promises.mkdir(newPath, { recursive: true });
  const res = await app.inject({
    method: 'POST',
    url: '/folders',
    headers: { cookie },
    payload: { path: newPath }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { folder: { path: string }; status: string };
  // First call returns either created or exists (auto-managed scan may
  // have inserted it already). Both are acceptable.
  assert.ok(['created', 'exists'].includes(body.status));
});

test('POST /folders is idempotent: repeat call returns exists', async () => {
  const seeded = await seedUser({ username: 'folders_idempotent' });
  const cookie = await cookieFor(seeded.user.id);
  const newPath = path.join(seeded.libraryRoot, 'twice');
  await fs.promises.mkdir(newPath, { recursive: true });
  await app.inject({ method: 'POST', url: '/folders', headers: { cookie }, payload: { path: newPath } });
  const second = await app.inject({
    method: 'POST',
    url: '/folders',
    headers: { cookie },
    payload: { path: newPath }
  });
  const body = second.json() as { status: string };
  assert.equal(body.status, 'exists');
});

test('DELETE /folders/:id returns 404 for an unknown id', async () => {
  const seeded = await seedUser({ username: 'folders_404' });
  const res = await app.inject({
    method: 'DELETE',
    url: '/folders/does-not-exist',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 404);
});

test('DELETE /folders/:id refuses to remove the user library root', async () => {
  const seeded = await seedUser({ username: 'folders_root_guard' });
  const cookie = await cookieFor(seeded.user.id);
  const list = await app.inject({ method: 'GET', url: '/folders', headers: { cookie } });
  const folders = (list.json() as { folders: Array<{ id: string; path: string }> }).folders;
  const rootFolder = folders.find((f) => path.resolve(f.path) === path.resolve(seeded.libraryRoot));
  assert.ok(rootFolder, 'expected library root in folder list');
  const del = await app.inject({
    method: 'DELETE',
    url: `/folders/${rootFolder!.id}`,
    headers: { cookie }
  });
  assert.equal(del.statusCode, 400);
  const body = del.json() as { error: string };
  assert.match(body.error, /library root/i);
});

test('DELETE /folders/:id removes a non-root folder', async () => {
  const seeded = await seedUser({ username: 'folders_delete_child' });
  const cookie = await cookieFor(seeded.user.id);
  const child = path.join(seeded.libraryRoot, 'gone');
  await fs.promises.mkdir(child, { recursive: true });
  // Refresh so the auto-managed sweep picks the new folder up.
  const listAfter = await app.inject({ method: 'GET', url: '/folders', headers: { cookie } });
  const childFolder = (listAfter.json() as { folders: Array<{ id: string; path: string }> }).folders.find(
    (f) => path.resolve(f.path) === path.resolve(child)
  );
  assert.ok(childFolder, 'child folder should be auto-registered');
  const del = await app.inject({
    method: 'DELETE',
    url: `/folders/${childFolder!.id}`,
    headers: { cookie }
  });
  assert.equal(del.statusCode, 200);
});

test('GET /folders of user A does not return user B folders', async () => {
  const alice = await seedUser({ username: 'folders_iso_a' });
  const bob = await seedUser({ username: 'folders_iso_b' });
  const aliceCookie = await cookieFor(alice.user.id);
  const aliceFolders = (
    await app.inject({ method: 'GET', url: '/folders', headers: { cookie: aliceCookie } })
  ).json() as { folders: Array<{ path: string }> };
  // No path leak: Alice's library root must not match Bob's library root.
  assert.equal(aliceFolders.folders.some((f) => path.resolve(f.path) === path.resolve(bob.libraryRoot)), false);
});
