// Broader coverage of /files. Range serving lives in files.range.test.ts;
// here we cover listing, tags, favorite toggle, upload + delete.
import './helpers/setupEnv';

import fs from 'fs';
import assert from 'node:assert/strict';
import path from 'path';

import { afterAll, afterEach, beforeAll, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';

import { config } from '../src/config';
import { sqlite } from '../src/db/client';
import { booruSitesRepo } from '../src/db/repos/booruSitesRepo';
import { favoritesRepo } from '../src/db/repos/favoritesRepo';
import { filesRepo } from '../src/db/repos/filesRepo';
import { foldersRepo } from '../src/db/repos/foldersRepo';

import { disarmFetchMock, setupFetchMock } from './helpers/fetchMock';
import {
  buildTestApp,
  seedUser,
  sessionCookieFor,
  registerFixtureFile,
  writeFixtureFile
} from './helpers/testApp';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

afterEach(disarmFetchMock);

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

test('POST /files/:id/tags/manual + suppress round-trips a tag', async () => {
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
    method: 'POST',
    url: `/files/${file.id}/tags/suppress`,
    headers: { cookie },
    payload: { tags: ['sunset'] }
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

test('POST /files/:id/vote accumulates score and blocks a second vote for 24h', async () => {
  const seeded = await seedUser({ username: 'files_vote_flow' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'votable.png',
    Buffer.from('x')
  );
  const file = await registerFixtureFile(folders[0].id, filePath);

  const up = await app.inject({
    method: 'POST',
    url: `/files/${file.id}/vote`,
    headers: { cookie },
    payload: { value: 1 }
  });
  assert.equal(up.statusCode, 200);
  const upBody = up.json() as { voteScore: number; nextVoteAt: string };
  assert.equal(upBody.voteScore, 1);
  assert.ok(
    Date.parse(upBody.nextVoteAt) > Date.now(),
    'nextVoteAt must be in the future right after voting'
  );

  const tooSoon = await app.inject({
    method: 'POST',
    url: `/files/${file.id}/vote`,
    headers: { cookie },
    payload: { value: -1 }
  });
  assert.equal(tooSoon.statusCode, 409);
  assert.equal((tooSoon.json() as { voteScore: number }).voteScore, 1);

  const listed = await app.inject({
    method: 'GET',
    url: '/files?sort=rated',
    headers: { cookie }
  });
  const voted = (
    listed.json() as { files: { id: string; voteScore: number }[] }
  ).files.find((entry) => entry.id === file.id);
  assert.equal(voted?.voteScore, 1, 'the score must survive a fresh read');

  // Backdate the vote past the cooldown to prove the next one accumulates.
  sqlite
    .prepare('UPDATE file_votes SET last_vote_at = ? WHERE file_id = ?')
    .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), file.id);
  const down = await app.inject({
    method: 'POST',
    url: `/files/${file.id}/vote`,
    headers: { cookie },
    payload: { value: -1 }
  });
  assert.equal(down.statusCode, 200);
  assert.equal((down.json() as { voteScore: number }).voteScore, 0);
});

test('POST /files/:id/vote refuses to take a score below zero', async () => {
  const seeded = await seedUser({ username: 'files_vote_floor' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'floor.png',
    Buffer.from('x')
  );
  const file = await registerFixtureFile(folders[0].id, filePath);

  const downFromNever = await app.inject({
    method: 'POST',
    url: `/files/${file.id}/vote`,
    headers: { cookie },
    payload: { value: -1 }
  });
  assert.equal(downFromNever.statusCode, 409);
  assert.equal((downFromNever.json() as { voteScore: number }).voteScore, 0);

  // The refusal must not burn the cooldown either — an upvote still works.
  const up = await app.inject({
    method: 'POST',
    url: `/files/${file.id}/vote`,
    headers: { cookie },
    payload: { value: 1 }
  });
  assert.equal(up.statusCode, 200);

  const backdate = () =>
    sqlite
      .prepare('UPDATE file_votes SET last_vote_at = ? WHERE file_id = ?')
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), file.id);
  backdate();
  const down = await app.inject({
    method: 'POST',
    url: `/files/${file.id}/vote`,
    headers: { cookie },
    payload: { value: -1 }
  });
  assert.equal(down.statusCode, 200);
  assert.equal((down.json() as { voteScore: number }).voteScore, 0);

  backdate();
  const downAgain = await app.inject({
    method: 'POST',
    url: `/files/${file.id}/vote`,
    headers: { cookie },
    payload: { value: -1 }
  });
  assert.equal(downAgain.statusCode, 409);
  assert.equal((downAgain.json() as { voteScore: number }).voteScore, 0);
});

test("vote lookup survives an id list past SQLite's bind limit", async () => {
  const seeded = await seedUser({ username: 'files_vote_chunk' });
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const file = await registerFixtureFile(
    folders[0].id,
    writeFixtureFile(folders[0].path, 'chunked.png', Buffer.from('x'))
  );
  sqlite
    .prepare(
      'INSERT INTO file_votes (file_id, score, last_vote_at) VALUES (?, ?, ?)'
    )
    .run(file.id, 4, '2026-01-01T00:00:00.000Z');

  // One statement cannot bind this many values, so an unchunked IN (...)
  // throws here rather than returning nothing.
  const padded = [
    file.id,
    ...Array.from({ length: 60_000 }, (_, i) => `missing-${i}`)
  ];
  const votes = await filesRepo.listVotesByFileIds(padded);
  assert.equal(votes.get(file.id)?.score, 4);
  assert.equal(votes.size, 1);
});

test('GET /files?sort=rated breaks score ties on who got there first', async () => {
  const seeded = await seedUser({ username: 'files_rated_order' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const register = async (name: string) =>
    registerFixtureFile(
      folders[0].id,
      writeFixtureFile(folders[0].path, name, Buffer.from(name))
    );

  const early = await register('early.png');
  const late = await register('late.png');
  const zeroed = await register('zeroed.png');
  const never = await register('never.png');

  // mtime deliberately runs opposite to the vote order: the old tie-break
  // was newest-first, so this fixture fails unless last_vote_at decides.
  const setMtime = (fileId: string, mtime: string) =>
    sqlite
      .prepare('UPDATE files SET mtime = ? WHERE id = ?')
      .run(mtime, fileId);
  setMtime(early.id, '2020-01-01T00:00:00.000Z');
  setMtime(late.id, '2030-01-01T00:00:00.000Z');
  setMtime(zeroed.id, '2030-01-01T00:00:00.000Z');
  setMtime(never.id, '2031-01-01T00:00:00.000Z');

  const vote = (fileId: string, score: number, at: string) =>
    sqlite
      .prepare(
        'INSERT INTO file_votes (file_id, score, last_vote_at) VALUES (?, ?, ?)'
      )
      .run(fileId, score, at);
  vote(early.id, 1, '2026-01-01T00:00:00.000Z');
  vote(late.id, 1, '2026-06-01T00:00:00.000Z');
  vote(zeroed.id, 0, '2026-06-01T00:00:00.000Z');

  const res = await app.inject({
    method: 'GET',
    url: '/files?sort=rated',
    headers: { cookie }
  });
  assert.equal(res.statusCode, 200);
  const order = (res.json() as { files: { id: string }[] }).files.map(
    (file) => file.id
  );
  assert.deepEqual(order, [early.id, late.id, zeroed.id, never.id]);
});

test('POST /files/:id/vote rejects a value other than 1 or -1 with 400', async () => {
  const seeded = await seedUser({ username: 'files_vote_bad' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'tmp.png',
    Buffer.from('x')
  );
  const file = await registerFixtureFile(folders[0].id, filePath);
  const res = await app.inject({
    method: 'POST',
    url: `/files/${file.id}/vote`,
    headers: { cookie },
    payload: { value: 5 }
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

test('DELETE /files/:id reverse-syncs custom Gelbooru favorites', async () => {
  const fm = setupFetchMock();
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
  // Verification re-fetch: favorites page no longer lists 123 → delete confirmed.
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: '<a href="index.php?page=post&amp;s=view&amp;id=999">x</a>'
  });

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

test('DELETE /files/:id reports an unconfirmed Gelbooru unfavorite', async () => {
  const fm = setupFetchMock();
  // Rule34 redirects on delete without proving removal (issue #144).
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
  // Verification re-fetch still finds 123 → the delete did not take.
  fm.intercept((url) => url.includes('s=view') && url.includes('pid='), {
    status: 200,
    body: '<a href="index.php?page=post&amp;s=view&amp;id=123">x</a>'
  });

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
  // No cookie configured → actionable message telling the user to add one.
  assert.match(body.errors?.join('\n') ?? '', /not confirmed/);
  assert.match(body.errors?.join('\n') ?? '', /add a session cookie/);
  // Local delete still proceeds even though the remote unfavorite is unconfirmed.
  assert.equal(fs.existsSync(filePath), false);
});

test('DELETE /files/:id deletes the thumbnail by basename from the thumbnails dir', async () => {
  const seeded = await seedUser({ username: 'files_delete_thumb' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const filePath = writeFixtureFile(
    folders[0].path,
    'with-thumb.png',
    ONE_BY_ONE_PNG
  );
  // Real thumb in the thumbnails dir; store a RELATIVE thumbPath like
  // production does. The delete must resolve it by basename, not assume it's
  // already absolute (the bug: "Unsafe path: expected absolute path").
  const thumbRoot = path.resolve(config.storage.thumbnailsDir);
  fs.mkdirSync(thumbRoot, { recursive: true });
  const thumbAbs = path.join(thumbRoot, 'with-thumb-thumb.jpg');
  fs.writeFileSync(thumbAbs, 'thumb-bytes');
  const file = await registerFixtureFile(folders[0].id, filePath, {
    thumbPath: 'storage/thumbnails/with-thumb-thumb.jpg'
  });

  const res = await app.inject({
    method: 'DELETE',
    url: `/files/${file.id}`,
    headers: { cookie }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { status: string; errors?: string[] };
  assert.equal(body.status, 'deleted');
  assert.equal(body.errors, undefined); // no "Unsafe path" error
  assert.equal(fs.existsSync(thumbAbs), false); // thumb actually removed
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

test('DELETE /files/:id returns 404 when another user tries to delete (IDOR)', async () => {
  const alice = await seedUser({ username: 'files_idor_alice' });
  const bob = await seedUser({ username: 'files_idor_bob' });
  const aliceFolders = await foldersRepo.listFolders(alice.user.id);
  const filePath = writeFixtureFile(
    aliceFolders[0].path,
    'alices-file.png',
    ONE_BY_ONE_PNG
  );
  const file = await registerFixtureFile(aliceFolders[0].id, filePath);

  const res = await app.inject({
    method: 'DELETE',
    url: `/files/${file.id}`,
    headers: { cookie: await cookieFor(bob.user.id) }
  });
  assert.equal(res.statusCode, 404);
  assert.ok(
    fs.existsSync(filePath),
    'file must not be deleted by another user'
  );
});

test('POST /folders/:id/uploads rejects content not matching extension', async () => {
  const seeded = await seedUser({ username: 'files_upload_mime_mismatch' });
  const cookie = await cookieFor(seeded.user.id);
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const boundary = 'gooncave-boundary';
  // Upload HTML content with a .png filename — bytes do not match declared extension.
  const htmlPayload = Buffer.from('<html><body>not an image</body></html>');
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="evil.png"\r\n` +
    `Content-Type: image/png\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const payload = Buffer.concat([
    Buffer.from(head),
    htmlPayload,
    Buffer.from(tail)
  ]);

  const res = await app.inject({
    method: 'POST',
    url: `/folders/${folders[0].id}/uploads`,
    headers: {
      cookie,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length)
    },
    payload
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    rejected: Array<{ name: string; reason: string }>;
  };
  assert.equal(body.rejected.length, 1);
  assert.match(body.rejected[0].reason, /does not match/i);
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
