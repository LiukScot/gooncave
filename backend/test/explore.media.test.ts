import './helpers/setupEnv';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';

import { config } from '../src/config';
import { remoteMediaCache } from '../src/services/remoteMedia';

import { buildTestApp, seedUser, sessionCookieFor } from './helpers/testApp';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  app = await buildTestApp();
  const seeded = await seedUser({ username: 'remote_media_route' });
  const session = await sessionCookieFor(seeded.user.id);
  cookie = `${session.name}=${session.value}`;
});

afterAll(async () => {
  await app.close();
});

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie } });

test('a media request without its signature is rejected as invalid', async () => {
  const res = await get('/explore/media?u=https%3A%2F%2Fcdn.test%2Fa.png');
  assert.equal(res.statusCode, 400, res.body);
});

test('a media url signed for another url is refused', async () => {
  const signed = remoteMediaCache.signedPath('https://cdn.test/a.png')!;
  const sig = new URL(signed, 'http://x').searchParams.get('s')!;
  const params = new URLSearchParams({ u: 'https://cdn.test/b.png', s: sig });
  const res = await get(`/explore/media?${params.toString()}`);
  assert.equal(res.statusCode, 403, res.body);
});

test('a cached image is served with headers that keep it inert', async () => {
  const url = 'https://cdn.test/cached.png';
  const hash = crypto.createHash('sha256').update(url).digest('hex');
  fs.mkdirSync(config.storage.remoteMediaDir, { recursive: true });
  fs.writeFileSync(path.join(config.storage.remoteMediaDir, hash), PNG);

  const res = await get(remoteMediaCache.signedPath(url)!);

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");
  assert.match(String(res.headers['cache-control']), /max-age=\d+/);
  assert.deepEqual(res.rawPayload, PNG);
});

test('a url the server may not reach answers 502 and is not cached by the browser', async () => {
  const res = await get(remoteMediaCache.signedPath('http://127.0.0.1/a.png')!);
  assert.equal(res.statusCode, 502, res.body);
  assert.equal(res.headers['cache-control'], 'no-store');
});
