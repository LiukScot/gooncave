// Unit tests for the remote media proxy cache. Fetch, time and sleeps are
// injected; the cache directory is a throwaway temp dir.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, test } from 'bun:test';

import { SsrfBlockedError } from '../lib/ssrfGuard';

import {
  createRemoteMediaCache,
  MAX_MEDIA_BYTES,
  RemoteMediaError
} from './remoteMedia';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-media-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const imageResponse = () =>
  new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });

const makeCache = (
  fetchImpl: (url: string) => Promise<Response>,
  overrides: { maxBytes?: number; maxAgeMs?: number; now?: () => number } = {}
) =>
  createRemoteMediaCache({
    dir,
    maxBytes: overrides.maxBytes ?? 1024 * 1024,
    maxAgeMs: overrides.maxAgeMs ?? 30 * 86_400_000,
    fetch: fetchImpl,
    now: overrides.now,
    sleep: async () => {}
  });

const signedParams = (signedPath: string | null) => {
  assert.ok(signedPath);
  const params = new URL(signedPath, 'http://x').searchParams;
  return { url: params.get('u')!, sig: params.get('s')! };
};

test('a signed path verifies only for the url it was signed for', () => {
  const cache = makeCache(async () => imageResponse());
  const { url, sig } = signedParams(
    cache.signedPath('https://cdn.example/a.jpg')
  );
  assert.equal(url, 'https://cdn.example/a.jpg');
  assert.equal(cache.verify(url, sig), true);
  assert.equal(cache.verify('https://cdn.example/b.jpg', sig), false);
  assert.equal(cache.verify(url, 'forged'), false);
});

test('the signing key survives a new cache instance on the same dir', () => {
  const first = makeCache(async () => imageResponse());
  const { url, sig } = signedParams(first.signedPath('https://cdn.example/a.jpg'));
  const second = makeCache(async () => imageResponse());
  assert.equal(second.verify(url, sig), true);
});

test('videos and non-http urls are left for the browser to load', () => {
  const cache = makeCache(async () => imageResponse());
  assert.equal(
    cache.signedPath('https://cdn.example/clip.webm?123'),
    'https://cdn.example/clip.webm?123'
  );
  assert.equal(cache.signedPath('data:image/png;base64,xx'), 'data:image/png;base64,xx');
  assert.equal(cache.signedPath(null), null);
});

test('a second load of the same url is served from disk', async () => {
  let calls = 0;
  const cache = makeCache(async () => {
    calls += 1;
    return imageResponse();
  });
  const [first, second] = await Promise.all([
    cache.load('https://cdn.example/a.png'),
    cache.load('https://cdn.example/a.png')
  ]);
  const third = await cache.load('https://cdn.example/a.png');
  assert.equal(calls, 1);
  assert.equal(first.contentType, 'image/png');
  assert.equal(second.filePath, first.filePath);
  assert.deepEqual(fs.readFileSync(third.filePath), PNG);
});

test('no more than four downloads run against one host at a time', async () => {
  let active = 0;
  let peak = 0;
  const cache = makeCache(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return imageResponse();
  });
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      cache.load(`https://cdn.example/${index}.png`)
    )
  );
  assert.equal(peak, 4);
});

test('a refused download is retried before giving up', async () => {
  const statuses = [403, 429, 200];
  const cache = makeCache(async () => {
    const status = statuses.shift()!;
    return status === 200 ? imageResponse() : new Response('', { status });
  });
  const loaded = await cache.load('https://cdn.example/a.png');
  assert.equal(loaded.contentType, 'image/png');
  assert.equal(statuses.length, 0);
});

test('a download still refused after the retries fails with its status', async () => {
  let calls = 0;
  const cache = makeCache(async () => {
    calls += 1;
    return new Response('', { status: 403 });
  });
  await assert.rejects(cache.load('https://cdn.example/a.png'), (error) => {
    assert.ok(error instanceof RemoteMediaError);
    assert.equal(error.status, 403);
    return true;
  });
  assert.equal(calls, 3);
});

test('a missing file is not retried', async () => {
  let calls = 0;
  const cache = makeCache(async () => {
    calls += 1;
    return new Response('', { status: 404 });
  });
  await assert.rejects(cache.load('https://cdn.example/a.png'), RemoteMediaError);
  assert.equal(calls, 1);
});

test('a body that is not an image is refused and not cached', async () => {
  const cache = makeCache(
    async () =>
      new Response('<html>Just a moment</html>', {
        status: 200,
        headers: { 'content-type': 'image/jpeg' }
      })
  );
  await assert.rejects(cache.load('https://cdn.example/a.jpg'), RemoteMediaError);
  const cached = fs.readdirSync(dir).filter((name) => !name.startsWith('.'));
  assert.deepEqual(cached, []);
});

test('an answer that is not an image is not downloaded again for a while', async () => {
  let now = Date.parse('2026-09-01T00:00:00Z');
  let calls = 0;
  const cache = makeCache(
    async () => {
      calls += 1;
      return new Response('%PDF-1.7', { status: 200 });
    },
    { now: () => now }
  );
  await assert.rejects(cache.load('https://cdn.example/story.pdf'), RemoteMediaError);
  await assert.rejects(cache.load('https://cdn.example/story.pdf'), RemoteMediaError);
  assert.equal(calls, 1);

  now += 24 * 60 * 60 * 1000;
  await assert.rejects(cache.load('https://cdn.example/story.pdf'), RemoteMediaError);
  assert.equal(calls, 2);
});

test('a blocked host is refused without retrying', async () => {
  let calls = 0;
  const cache = makeCache(async () => {
    calls += 1;
    throw new SsrfBlockedError('blocked');
  });
  await assert.rejects(cache.load('https://cdn.example/a.png'), SsrfBlockedError);
  assert.equal(calls, 1);
});

test('a refused answer releases its body before the retry', async () => {
  let cancelled = 0;
  const cache = makeCache(async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled += 1;
      }
    });
    return new Response(body, { status: 403 });
  });
  await assert.rejects(cache.load('https://cdn.example/a.png'), RemoteMediaError);
  assert.equal(cancelled, 3);
});

test('an image format outside the safe list is refused', async () => {
  // A BMP header: a real image, but not one of the formats served back.
  const bmp = Buffer.alloc(64);
  bmp.write('BM', 0, 'ascii');
  bmp.writeUInt32LE(64, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  const cache = makeCache(async () => new Response(bmp, { status: 200 }));
  await assert.rejects(cache.load('https://cdn.example/a.bmp'), RemoteMediaError);
});

test('a body past the size cap is refused while reading, without a length header', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
    }
  });
  const cache = makeCache(async () => new Response(endless, { status: 200 }));
  await assert.rejects(cache.load('https://cdn.example/a.png'), (error) => {
    assert.ok(error instanceof RemoteMediaError);
    assert.match(error.message, /too large/);
    return true;
  });
  assert.ok(pulled <= MAX_MEDIA_BYTES / chunk.byteLength + 2);
});

test('prune drops files unused past the age limit, then the least recent over the size cap', async () => {
  const start = Date.parse('2026-09-01T00:00:00Z');
  const minute = 60_000;
  let now = start;
  const cache = makeCache(async () => imageResponse(), {
    maxAgeMs: 10 * minute,
    maxBytes: PNG.length * 2,
    now: () => now
  });
  const stale = await cache.load('https://cdn.example/stale.png');
  now += 5 * minute;
  const oldest = await cache.load('https://cdn.example/oldest.png');
  now += minute;
  const middle = await cache.load('https://cdn.example/middle.png');
  now += minute;
  const newest = await cache.load('https://cdn.example/newest.png');
  now += minute;
  // Serving a file counts as using it: `oldest` becomes the most recent.
  await cache.load('https://cdn.example/oldest.png');
  cache.signedPath('https://cdn.example/stale.png');
  now = start + 11 * minute;

  await cache.prune();

  const exists = (file: { filePath: string }) => fs.existsSync(file.filePath);
  assert.equal(exists(stale), false);
  assert.equal(exists(middle), false);
  assert.equal(exists(newest), true);
  assert.equal(exists(oldest), true);
  assert.ok(fs.existsSync(path.join(dir, '.signing-key')));
});
