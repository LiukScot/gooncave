import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';

import { afterAll, beforeAll, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';

import {
  buildTestApp,
  registerFixtureFile,
  seedUser,
  sessionCookieFor,
  writeFixtureFile
} from './helpers/testApp';

let app: FastifyInstance;
let cookieHeader: string;
let fileId: string;
let filePath: string;
const fileBytes = Buffer.from('0123456789abcdefghij'); // 20 bytes

beforeAll(async () => {
  app = await buildTestApp();
  const seeded = await seedUser({ username: 'range_user' });
  filePath = writeFixtureFile(
    path.join(seeded.libraryRoot, 'sub'),
    'a.png',
    fileBytes
  );
  // Find the folder created by seedUser then attach a file to it.
  const session = await sessionCookieFor(seeded.user.id);
  cookieHeader = `${session.name}=${session.value}`;

  // Re-fetch folder to register file under the right folderId.
  const folders = await app
    .inject({
      method: 'GET',
      url: '/folders',
      headers: { cookie: cookieHeader }
    })
    .then((r) => r.json());
  const folderId = folders.folders[0].id;
  const file = await registerFixtureFile(folderId, filePath);
  fileId = file.id;
});

afterAll(async () => {
  await app.close();
});

test('GET /files/:id/content without Range returns 200 + full body', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/files/${fileId}/content`,
    headers: { cookie: cookieHeader }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.headers['cache-control'], 'private, no-cache');
  assert.match(String(res.headers.etag), /^"[a-f0-9]{32,64}-\d+-\d+"$/);
  assert.doesNotThrow(() => new Date(String(res.headers['last-modified'])));
  assert.equal(res.rawPayload.length, fileBytes.length);
});

test('GET /files/:id/content returns 304 for the current ETag', async () => {
  const initial = await app.inject({
    method: 'GET',
    url: `/files/${fileId}/content`,
    headers: { cookie: cookieHeader }
  });
  const res = await app.inject({
    method: 'GET',
    url: `/files/${fileId}/content`,
    headers: {
      cookie: cookieHeader,
      'if-none-match': String(initial.headers.etag)
    }
  });
  assert.equal(res.statusCode, 304);
  assert.equal(res.rawPayload.length, 0);
  assert.equal(res.headers.etag, initial.headers.etag);
});

test('GET /files/:id/content ignores a stale ETag', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/files/${fileId}/content`,
    headers: { cookie: cookieHeader, 'if-none-match': '"stale"' }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload.toString(), fileBytes.toString());
});

test('GET /files/:id/content with Range bytes=0-9 returns 206 + first 10 bytes', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/files/${fileId}/content`,
    headers: { cookie: cookieHeader, range: 'bytes=0-9' }
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-range'], `bytes 0-9/${fileBytes.length}`);
  assert.match(String(res.headers.etag), /^"[a-f0-9]{32,64}-\d+-\d+"$/);
  assert.equal(res.rawPayload.toString(), '0123456789');
});

test('GET /files/:id/content ignores Range when If-Range is stale', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/files/${fileId}/content`,
    headers: {
      cookie: cookieHeader,
      range: 'bytes=0-9',
      'if-range': '"stale"'
    }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-range'], undefined);
  assert.equal(res.rawPayload.toString(), fileBytes.toString());
});

test('GET /files/:id/content with suffix Range bytes=-5 returns last 5 bytes', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/files/${fileId}/content`,
    headers: { cookie: cookieHeader, range: 'bytes=-5' }
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-range'], `bytes 15-19/${fileBytes.length}`);
  assert.equal(res.rawPayload.toString(), 'fghij');
});

test('GET /files/:id/content with Range past EOF clamps end', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/files/${fileId}/content`,
    headers: { cookie: cookieHeader, range: 'bytes=10-9999' }
  });
  assert.equal(res.statusCode, 206);
  assert.equal(
    res.headers['content-range'],
    `bytes 10-${fileBytes.length - 1}/${fileBytes.length}`
  );
});

test('Regression #46: empty Range bytes=- returns 416, not 206', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/files/${fileId}/content`,
    headers: { cookie: cookieHeader, range: 'bytes=-' }
  });
  assert.equal(res.statusCode, 416);
  assert.equal(res.headers['content-range'], `bytes */${fileBytes.length}`);
});

test('GET /files/:id/content with start past EOF returns 416', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/files/${fileId}/content`,
    headers: { cookie: cookieHeader, range: `bytes=${fileBytes.length}-` }
  });
  assert.equal(res.statusCode, 416);
});

test('GET /files/:id/content without auth cookie returns 401', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/files/${fileId}/content`
  });
  assert.equal(res.statusCode, 401);
});

test('GET /files/:id/content changes ETag when the file changes on disk', async () => {
  const initial = await app.inject({
    method: 'GET',
    url: `/files/${fileId}/content`,
    headers: { cookie: cookieHeader }
  });
  await fs.promises.appendFile(filePath, '!');
  const changed = await app.inject({
    method: 'GET',
    url: `/files/${fileId}/content`,
    headers: {
      cookie: cookieHeader,
      'if-none-match': String(initial.headers.etag)
    }
  });
  assert.equal(changed.statusCode, 200);
  assert.notEqual(changed.headers.etag, initial.headers.etag);
  assert.equal(changed.rawPayload.length, fileBytes.length + 1);
});
