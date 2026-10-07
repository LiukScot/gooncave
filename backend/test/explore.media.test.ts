import './helpers/setupEnv';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';

import { config } from '../src/config';
import {
  MediaTooLargeError,
  remoteMediaCache,
  withCachedMedia
} from '../src/services/remoteMedia';

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

test('Gelbooru previews and samples use the authenticated image cache', async () => {
  const post = {
    previewUrl: 'https://img4.gelbooru.com/thumbnails/example.png',
    sampleUrl: 'https://img4.gelbooru.com/samples/example.png',
    fileUrl: 'https://img4.gelbooru.com/images/original.png'
  };
  const media = withCachedMedia(post, {});

  assert.equal(
    remoteMediaCache.verifiedUrlFromSignedPath(media.previewUrl!),
    post.previewUrl
  );
  assert.equal(
    remoteMediaCache.verifiedUrlFromSignedPath(media.sampleUrl!),
    post.sampleUrl
  );
  assert.equal(media.fileUrl, post.fileUrl);

  const hash = crypto.createHash('sha256').update(post.sampleUrl).digest('hex');
  fs.mkdirSync(config.storage.remoteMediaDir, { recursive: true });
  fs.writeFileSync(path.join(config.storage.remoteMediaDir, hash), PNG);
  const res = await get(media.sampleUrl!);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.deepEqual(res.rawPayload, PNG);
});

test('a Gelbooru sample does not proxy another host in the same post', () => {
  const post = {
    previewUrl: 'https://cdn.example/preview.png',
    sampleUrl: 'https://img4.gelbooru.com/sample.png'
  };
  const media = withCachedMedia(post, {});
  assert.equal(media.previewUrl, post.previewUrl);
  assert.equal(
    remoteMediaCache.verifiedUrlFromSignedPath(media.sampleUrl!),
    post.sampleUrl
  );
});

test('other sites and Gelbooru lookalike hosts keep their media URLs', () => {
  for (const host of ['cdn.example', 'notgelbooru.com', 'gelbooru.com.example']) {
    const post = {
      previewUrl: `https://${host}/preview.png`,
      sampleUrl: `https://${host}/sample.png`
    };
    assert.equal(withCachedMedia(post, {}), post);
  }
  const post = {
    previewUrl: 'https://gelbooru.com@cdn.example/preview.png',
    sampleUrl: 'not a URL'
  };
  assert.equal(withCachedMedia(post, {}), post);
});

test('existing proxy-enabled engines still proxy previews from any host', () => {
  const post = {
    previewUrl: 'https://cdn.example/preview.png',
    sampleUrl: null
  };
  const media = withCachedMedia(post, { proxiesPreviews: true });
  assert.equal(
    remoteMediaCache.verifiedUrlFromSignedPath(media.previewUrl!),
    post.previewUrl
  );
  assert.equal(media.sampleUrl, null);
});

test('Gelbooru videos stay direct instead of entering the still-image cache', () => {
  const post = {
    previewUrl: null,
    sampleUrl: 'https://img4.gelbooru.com/sample.webm'
  };
  assert.deepEqual(withCachedMedia(post, {}), post);
});

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

test('an oversized FurAffinity original falls back to its direct URL', async () => {
  const url = 'https://d.furaffinity.net/art/demo/large.png';
  const originalLoad = remoteMediaCache.load;
  remoteMediaCache.load = async () => {
    throw new MediaTooLargeError(200);
  };
  try {
    const res = await get(remoteMediaCache.signedPath(url)!);
    assert.equal(res.statusCode, 302, res.body);
    assert.equal(res.headers.location, url);
    assert.equal(res.headers['cache-control'], 'no-store');

    const other = await get(
      remoteMediaCache.signedPath('https://cdn.test/large.png')!
    );
    assert.equal(other.statusCode, 502, other.body);
    assert.equal(other.headers.location, undefined);
  } finally {
    remoteMediaCache.load = originalLoad;
  }
});
