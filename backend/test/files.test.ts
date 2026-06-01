// Broader coverage of /files. Range serving lives in files.range.test.ts;
// here we cover listing, tags, favorite toggle, upload + delete.
import './helpers/setupEnv';

import fs from 'fs';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import path from 'path';

import type { FastifyInstance } from 'fastify';

import { booruSitesRepo } from '../src/db/repos/booruSitesRepo';
import { favoritesRepo } from '../src/db/repos/favoritesRepo';
import { foldersRepo } from '../src/db/repos/foldersRepo';

import { setupFetchMock } from './helpers/fetchMock';
import {
  buildTestApp,
  seedUser,
  sessionCookieFor,
  registerFixtureFile,
  writeFixtureFile
} from './helpers/testApp';

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

// Real PNG with valid 1x1 dimensions, so the scanner can pull width/height.
// Smaller than sharp's minimum decode path would handle without panicking.
const ONE_BY_ONE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cf' +
    'c0c00000000300017c6bf3060000000049454e44ae426082',
  'hex'
);

test('GET /files without cookie returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/files' });
  assert.equal(res.statusCode, 401);
});

test('GET /files returns empty list for a fresh user', async () => {
  const seeded = await seedUser({ username: 'files_fresh' });
  const res = await app.inject({
    method: 'GET',
    url: '/files',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { files: unknown[]; total: number };
  assert.deepEqual(body.files, []);
  assert.equal(body.total, 0);
});

test('GET /files rejects invalid query parameters with 400', async () => {
  const seeded = await seedUser({ username: 'files_bad_query' });
  const res = await app.inject({
    method: 'GET',
    url: '/files?sort=banana',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 400);
});

test("GET /files only returns the caller's files", async () => {
  const alice = await seedUser({ username: 'files_iso_a' });
  const bob = await seedUser({ username: 'files_iso_b' });
  // Seed Alice with a file via the lower-level helpers.
  const aliceFolders = await foldersRepo.listFolders(alice.user.id);
  const aliceFile = writeFixtureFile(
    aliceFolders[0].path,
    'a.png',
    Buffer.from('x')
  );
  await registerFixtureFile(aliceFolders[0].id, aliceFile);

  const bobRes = await app.inject({
    method: 'GET',
    url: '/files',
    headers: { cookie: await cookieFor(bob.user.id) }
  });
  assert.equal(bobRes.statusCode, 200);
  assert.deepEqual((bobRes.json() as { files: unknown[] }).files, []);
});

test('GET /files/:id/tags returns empty list for a freshly-seeded file', async () => {
  const seeded = await seedUser({ username: 'files_tags_empty' });
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'untagged.png',
    Buffer.from('x')
  );
  const file = await registerFixtureFile(folders[0].id, filePath);
  const res = await app.inject({
    method: 'GET',
    url: `/files/${file.id}/tags`,
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { tags: unknown[] }).tags, []);
});

test('GET /files/:id/tags for an unknown id returns 404', async () => {
  const seeded = await seedUser({ username: 'files_tags_404' });
  const res = await app.inject({
    method: 'GET',
    url: '/files/non-existent-id/tags',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 404);
});

test('POST /files/:id/tags/manual + DELETE round-trips a tag', async () => {
  const seeded = await seedUser({ username: 'files_manual_tag' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'taggable.png',
    Buffer.from('x')
  );
  const file = await registerFixtureFile(folders[0].id, filePath);

  const add = await app.inject({
    method: 'POST',
    url: `/files/${file.id}/tags/manual`,
    headers: { cookie },
    payload: { tag: 'sunset', category: 'general' }
  });
  assert.equal(add.statusCode, 200);

  const afterAdd = await app.inject({
    method: 'GET',
    url: `/files/${file.id}/tags`,
    headers: { cookie }
  });
  const tagsAfterAdd = (
    afterAdd.json() as { tags: Array<{ tag: string; source: string }> }
  ).tags;
  assert.ok(
    tagsAfterAdd.some((t) => t.tag === 'sunset' && t.source === 'MANUAL')
  );

  const remove = await app.inject({
    method: 'DELETE',
    url: `/files/${file.id}/tags/manual`,
    headers: { cookie },
    payload: { tag: 'sunset', category: 'general' }
  });
  assert.equal(remove.statusCode, 200);

  const afterRemove = await app.inject({
    method: 'GET',
    url: `/files/${file.id}/tags`,
    headers: { cookie }
  });
  const tagsAfterRemove = (
    afterRemove.json() as { tags: Array<{ tag: string }> }
  ).tags;
  assert.equal(
    tagsAfterRemove.some((t) => t.tag === 'sunset'),
    false
  );
});

test('PUT /files/:id/favorite toggles isFavorite and persists across reads', async () => {
  const seeded = await seedUser({ username: 'files_fav_toggle' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'favable.png',
    Buffer.from('x')
  );
  const file = await registerFixtureFile(folders[0].id, filePath);

  const on = await app.inject({
    method: 'PUT',
    url: `/files/${file.id}/favorite`,
    headers: { cookie },
    payload: { favorite: true }
  });
  assert.equal((on.json() as { isFavorite: boolean }).isFavorite, true);

  const off = await app.inject({
    method: 'PUT',
    url: `/files/${file.id}/favorite`,
    headers: { cookie },
    payload: { favorite: false }
  });
  assert.equal((off.json() as { isFavorite: boolean }).isFavorite, false);
});

test('PUT /files/:id/favorite rejects non-boolean payload with 400', async () => {
  const seeded = await seedUser({ username: 'files_fav_bad' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'tmp.png',
    Buffer.from('x')
  );
  const file = await registerFixtureFile(folders[0].id, filePath);
  const res = await app.inject({
    method: 'PUT',
    url: `/files/${file.id}/favorite`,
    headers: { cookie },
    payload: { favorite: 'yes' }
  });
  assert.equal(res.statusCode, 400);
});

test('DELETE /files/:id removes the file from disk and DB', async () => {
  const seeded = await seedUser({ username: 'files_delete_ok' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'to-delete.png',
    ONE_BY_ONE_PNG
  );
  const file = await registerFixtureFile(folders[0].id, filePath);

  assert.equal(fs.existsSync(filePath), true);
  const res = await app.inject({
    method: 'DELETE',
    url: `/files/${file.id}`,
    headers: { cookie }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { status: string };
  assert.equal(body.status, 'deleted');
  assert.equal(fs.existsSync(filePath), false);
});

test('DELETE /files/:id removes every favorite mapping for the deleted path', async () => {
  const seeded = await seedUser({ username: 'files_delete_all_favs' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'to-delete-favs.png',
    ONE_BY_ONE_PNG
  );
  const file = await registerFixtureFile(folders[0].id, filePath);

  await favoritesRepo.upsertFavoriteItem(
    {
      provider: 'E621',
      remoteId: '111',
      filePath: file.path,
      sourceUrl: 'https://e621.net/posts/111',
      fileUrl: null
    },
    seeded.user.id
  );
  await favoritesRepo.upsertFavoriteItem(
    {
      provider: 'DANBOORU',
      remoteId: '222',
      filePath: file.path,
      sourceUrl: 'https://danbooru.donmai.us/posts/222',
      fileUrl: null
    },
    seeded.user.id
  );
  assert.equal(
    (await favoritesRepo.listFavoriteItemsByPath(file.path, seeded.user.id))
      .length,
    2
  );

  const res = await app.inject({
    method: 'DELETE',
    url: `/files/${file.id}`,
    headers: { cookie }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(
    (await favoritesRepo.listFavoriteItemsByPath(file.path, seeded.user.id))
      .length,
    0
  );
});

test('DELETE /files/:id reverse-syncs custom Gelbooru favorites', async (t) => {
  const fm = setupFetchMock(t);
  let capturedUrl = '';
  fm.intercept(
    (url) => {
      const matches =
        url.includes('page=favorites') &&
        url.includes('s=delete') &&
        url.includes('id=123');
      if (matches) capturedUrl = url;
      return matches;
    },
    { status: 200, body: '' }
  );

  const seeded = await seedUser({ username: 'files_delete_gelbooru_reverse' });
  const cookie = await cookieFor(seeded.user.id);
  const site = await booruSitesRepo.insertBooruSite(
    {
      name: 'Gelbooru',
      engine: 'gelbooru',
      baseUrl: 'https://gelbooru.com',
      username: '42',
      apiKey: 'testkey',
      isPreset: false,
      enabled: true,
      siteReverseSyncEnabled: true
    },
    seeded.user.id
  );
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'gelbooru-fav.png',
    ONE_BY_ONE_PNG
  );
  const file = await registerFixtureFile(folders[0].id, filePath);
  await favoritesRepo.upsertFavoriteItem(
    {
      provider: site.id,
      remoteId: '123',
      filePath: file.path,
      sourceUrl: 'https://gelbooru.com/index.php?page=post&s=view&id=123',
      fileUrl: null
    },
    seeded.user.id
  );

  const res = await app.inject({
    method: 'DELETE',
    url: `/files/${file.id}`,
    headers: { cookie }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { status: string; errors?: string[] };
  assert.equal(body.status, 'deleted');
  assert.equal(body.errors, undefined);
  assert.match(capturedUrl, /page=favorites/);
  assert.match(capturedUrl, /s=delete/);
  assert.match(capturedUrl, /id=123/);
});

test('DELETE /files/:id reports Gelbooru unfavorite redirects', async (t) => {
  const fm = setupFetchMock(t);
  fm.intercept(
    (url) =>
      url.includes('page=favorites') &&
      url.includes('s=delete') &&
      url.includes('id=123'),
    {
      status: 302,
      body: '',
      headers: { location: '/index.php?page=favorites&s=view&id=' }
    }
  );

  const seeded = await seedUser({ username: 'files_delete_rule34_redirect' });
  const cookie = await cookieFor(seeded.user.id);
  const site = await booruSitesRepo.insertBooruSite(
    {
      name: 'Rule34',
      engine: 'gelbooru',
      baseUrl: 'https://rule34.xxx',
      username: '42',
      apiKey: 'testkey',
      isPreset: false,
      enabled: true,
      siteReverseSyncEnabled: true
    },
    seeded.user.id
  );
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'rule34-fav.png',
    ONE_BY_ONE_PNG
  );
  const file = await registerFixtureFile(folders[0].id, filePath);
  await favoritesRepo.upsertFavoriteItem(
    {
      provider: site.id,
      remoteId: '123',
      filePath: file.path,
      sourceUrl: 'https://rule34.xxx/index.php?page=post&s=view&id=123',
      fileUrl: null
    },
    seeded.user.id
  );

  const res = await app.inject({
    method: 'DELETE',
    url: `/files/${file.id}`,
    headers: { cookie }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { status: string; errors?: string[] };
  assert.equal(body.status, 'deleted');
  assert.match(body.errors?.join('\n') ?? '', /unfavorite redirected/);
  assert.equal(fs.existsSync(filePath), false);
});

test('DELETE /files/:id returns 404 for an unknown id', async () => {
  const seeded = await seedUser({ username: 'files_delete_404' });
  const res = await app.inject({
    method: 'DELETE',
    url: '/files/no-such-id',
    headers: { cookie: await cookieFor(seeded.user.id) }
  });
  assert.equal(res.statusCode, 404);
});

test('POST /folders/:id/uploads with no parts returns 400', async () => {
  const seeded = await seedUser({ username: 'files_upload_empty' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  // Empty multipart body — no files uploaded.
  const res = await app.inject({
    method: 'POST',
    url: `/folders/${folders[0].id}/uploads`,
    headers: { cookie, 'content-type': 'multipart/form-data; boundary=----X' },
    payload: '------X--\r\n'
  });
  assert.equal(res.statusCode, 400);
});

test('POST /folders/:id/uploads returns 404 for an unknown folder id', async () => {
  const seeded = await seedUser({ username: 'files_upload_404' });
  const res = await app.inject({
    method: 'POST',
    url: '/folders/no-such-folder/uploads',
    headers: {
      cookie: await cookieFor(seeded.user.id),
      'content-type': 'multipart/form-data; boundary=----X'
    },
    payload: '------X--\r\n'
  });
  assert.equal(res.statusCode, 404);
});

// Pin that the route returns a content body for downloads. Range-specific
// behavior stays in files.range.test.ts.
test('GET /files/:id/content?download=1 sets Content-Disposition attachment', async () => {
  const seeded = await seedUser({ username: 'files_download_attachment' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'pic.png',
    Buffer.from('payload')
  );
  const file = await registerFixtureFile(folders[0].id, filePath);
  const res = await app.inject({
    method: 'GET',
    url: `/files/${file.id}/content?download=1`,
    headers: { cookie }
  });
  assert.equal(res.statusCode, 200);
  // path also asserts non-leak (filename encoded, no traversal).
  assert.match(
    String(res.headers['content-disposition']),
    /^attachment; filename="pic\.png"/
  );
});

// Cleanup path probed: use a path that we know exists under the seeded
// library to ensure the file count doesn't leak between tests.
test('GET /files filters by mediaType=IMAGE', async () => {
  const seeded = await seedUser({ username: 'files_media_filter' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'still.png',
    Buffer.from('x')
  );
  await registerFixtureFile(folders[0].id, filePath, { mediaType: 'IMAGE' });
  // No video, so VIDEO filter should be empty.
  const videoRes = await app.inject({
    method: 'GET',
    url: '/files?mediaType=VIDEO',
    headers: { cookie }
  });
  assert.deepEqual((videoRes.json() as { files: unknown[] }).files, []);
  const imageRes = await app.inject({
    method: 'GET',
    url: '/files?mediaType=IMAGE',
    headers: { cookie }
  });
  assert.equal((imageRes.json() as { files: unknown[] }).files.length, 1);
});

// Avoid `path` import-shadow false-positive; use it explicitly once.
void path;
