import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config';
import type { BooruEngineModule } from '../lib/booruEngines/types';
import { safeFetch } from '../lib/ssrfGuard';

/**
 * Booru previews served through this server instead of straight from the
 * booru's CDN, for engines that set `proxiesPreviews`.
 *
 * A grid page asks one CDN for dozens of thumbnails at once, and Cloudflare in
 * front of FurAffinity answers a burst like that with 403 for a minute or two.
 * Going through here, a host gets at most a few requests at a time, a refused
 * one is retried, and a thumbnail already seen never costs another request.
 *
 * Only urls this server signed are fetched: without the signature the route
 * would download anything a logged-in user named.
 */

export const REMOTE_MEDIA_ROUTE = '/explore/media';
/** Largest preview the cache stores, in bytes. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const KEY_FILE = '.signing-key';
const CACHE_FILE = /^[0-9a-f]{64}$/;
const TEMP_FILE = /^[0-9a-f]{64}\.tmp-/;
const HOST_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRYABLE_STATUSES = new Set([403, 429, 500, 502, 503, 504]);
const FETCH_TIMEOUT_MS = 20_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const TEMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
// Mirrors the frontend's isVideoUrl: a <video> needs range requests, which
// this cache does not serve, so clips stay a direct browser load.
const VIDEO_PATH = /\.(mp4|webm|m4v|mov)$/i;

export class RemoteMediaError extends Error {
  constructor(
    message: string,
    /** Upstream HTTP status, or null when the download never got an answer. */
    readonly status: number | null
  ) {
    super(message);
    this.name = 'RemoteMediaError';
  }
}

// The slice of a fetch Response this cache reads. Structural, so undici's
// Response (safeFetch) and the global one (tests) both fit.
type MediaResponse = {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  body: AsyncIterable<Uint8Array> | null;
};
type MediaRequestInit = { headers: Record<string, string>; signal: AbortSignal };

type RemoteMediaOptions = {
  dir: string;
  /** Size the cache is pruned back to, in bytes. */
  maxBytes: number;
  /** A file not served for this long is deleted on the next prune. */
  maxAgeMs: number;
  fetch?: (url: string, init: MediaRequestInit) => Promise<MediaResponse>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type CachedMedia = { filePath: string; contentType: string };

const isProxiable = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !VIDEO_PATH.test(parsed.pathname)
    );
  } catch {
    return false;
  }
};

const readOrCreateKey = (dir: string): Buffer => {
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, KEY_FILE);
  try {
    fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return fs.readFileSync(keyPath);
};

// Served from this origin, so only formats that cannot carry script. SVG is
// never on the list: file-type does not detect it, and it must stay that way.
const SAFE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif'
]);

const sniffImageType = async (body: Buffer): Promise<string | null> => {
  const { fileTypeFromBuffer } = await import('file-type');
  const detected = await fileTypeFromBuffer(body);
  return detected && SAFE_IMAGE_TYPES.has(detected.mime) ? detected.mime : null;
};

// file-type only looks at the leading bytes; 4100 is its recommended sample.
const readHead = async (filePath: string): Promise<Buffer | null> => {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(4100);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

// Counted while reading: a CDN that sends no Content-Length would otherwise
// get its whole answer buffered before the size is known.
const readCapped = async (
  body: AsyncIterable<Uint8Array> | null,
  status: number
): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Throwing out of the loop cancels the stream, so the rest is never read.
  for await (const chunk of body ?? []) {
    size += chunk.byteLength;
    if (size > MAX_MEDIA_BYTES) {
      throw new RemoteMediaError('media is too large to cache', status);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

export const createRemoteMediaCache = (options: RemoteMediaOptions) => {
  const fetchImpl = options.fetch ?? safeFetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let key: Buffer | null = null;
  const inflight = new Map<string, Promise<CachedMedia>>();
  const hostSlots = new Map<string, { active: number; queue: (() => void)[] }>();
  let lastPruneAt = 0;
  let pruning: Promise<void> | null = null;

  const signature = (url: string): string => {
    key ??= readOrCreateKey(options.dir);
    return crypto.createHmac('sha256', key).update(url).digest('base64url');
  };

  const withHostSlot = async <T>(host: string, task: () => Promise<T>) => {
    const slot = hostSlots.get(host) ?? { active: 0, queue: [] };
    hostSlots.set(host, slot);
    if (slot.active < HOST_CONCURRENCY) {
      slot.active += 1;
    } else {
      await new Promise<void>((resolve) => slot.queue.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = slot.queue.shift();
      if (next) next();
      else slot.active -= 1;
    }
  };

  const touch = (filePath: string) => {
    const at = new Date(now());
    return fs.promises.utimes(filePath, at, at);
  };

  const download = async (url: string): Promise<Buffer> => {
    const origin = new URL(url).origin;
    for (let attempt = 1; ; attempt += 1) {
      let res: MediaResponse;
      try {
        res = await fetchImpl(url, {
          headers: {
            'User-Agent': config.e621.userAgent,
            Accept: 'image/*',
            // Some CDNs (danbooru's) refuse a request with no Referer at all.
            Referer: `${origin}/`
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new RemoteMediaError(
            `download failed: ${(error as Error).message}`,
            null
          );
        }
        await sleep(RETRY_BASE_DELAY_MS * 3 ** (attempt - 1));
        continue;
      }
      if (res.ok) {
        const length = Number(res.headers.get('content-length'));
        if (length > MAX_MEDIA_BYTES) {
          throw new RemoteMediaError('media is too large to cache', res.status);
        }
        return readCapped(res.body, res.status);
      }
      if (!RETRYABLE_STATUSES.has(res.status) || attempt >= MAX_ATTEMPTS) {
        throw new RemoteMediaError(`upstream answered ${res.status}`, res.status);
      }
      await sleep(RETRY_BASE_DELAY_MS * 3 ** (attempt - 1));
    }
  };

  const prune = async (): Promise<void> => {
    const cutoff = now() - options.maxAgeMs;
    const kept: { filePath: string; size: number; mtimeMs: number }[] = [];
    for (const name of await fs.promises.readdir(options.dir)) {
      const filePath = path.join(options.dir, name);
      const isTemp = TEMP_FILE.test(name);
      if (!isTemp && !CACHE_FILE.test(name)) continue;
      const stat = await fs.promises.stat(filePath).catch((error: unknown) => {
        // Deleted by a concurrent prune or rename between readdir and stat.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) continue;
      const expired = isTemp
        ? stat.mtimeMs < now() - TEMP_FILE_MAX_AGE_MS
        : stat.mtimeMs < cutoff;
      if (expired) await fs.promises.rm(filePath, { force: true });
      else if (!isTemp) kept.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    let total = kept.reduce((sum, file) => sum + file.size, 0);
    kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of kept) {
      if (total <= options.maxBytes) break;
      await fs.promises.rm(file.filePath, { force: true });
      total -= file.size;
    }
  };

  const pruneIfDue = () => {
    if (pruning || now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
    lastPruneAt = now();
    pruning = prune()
      .catch((error: unknown) => {
        console.warn(`[remote-media] prune failed: ${(error as Error).message}`);
      })
      .finally(() => {
        pruning = null;
      });
  };

  const fetchAndStore = async (url: string, filePath: string) => {
    const body = await withHostSlot(new URL(url).host, () => download(url));
    const contentType = await sniffImageType(body);
    if (!contentType) {
      throw new RemoteMediaError('upstream did not answer with an image', 200);
    }
    const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
    await fs.promises.writeFile(tempPath, body);
    await touch(tempPath);
    await fs.promises.rename(tempPath, filePath);
    pruneIfDue();
    return { filePath, contentType };
  };

  const load = async (url: string): Promise<CachedMedia> => {
    const hash = crypto.createHash('sha256').update(url).digest('hex');
    const filePath = path.join(options.dir, hash);
    const pending = inflight.get(hash);
    if (pending) return pending;
    const task = (async () => {
      await fs.promises.mkdir(options.dir, { recursive: true });
      const head = await readHead(filePath);
      if (head) {
        const contentType = await sniffImageType(head);
        // A prune may delete the file between the read and the touch; it
        // is then downloaded again like any other miss.
        const touched = contentType
          ? await touch(filePath).then(
              () => true,
              (error: unknown) => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
                throw error;
              }
            )
          : false;
        if (contentType && touched) {
          pruneIfDue();
          return { filePath, contentType };
        }
      }
      return fetchAndStore(url, filePath);
    })().finally(() => inflight.delete(hash));
    inflight.set(hash, task);
    return task;
  };

  return {
    /**
     * The server path a post's preview is served from, or the url unchanged
     * when it is not something this cache handles (a video, a data: url).
     * Relative, like a library thumbUrl: the frontend prefixes its API base.
     */
    signedPath(url: string | null): string | null {
      if (!url || !isProxiable(url)) return url;
      const params = new URLSearchParams({ u: url, s: signature(url) });
      return `${REMOTE_MEDIA_ROUTE}?${params.toString()}`;
    },

    verify(url: string, sig: string): boolean {
      const expected = Buffer.from(signature(url));
      const given = Buffer.from(sig);
      return (
        expected.length === given.length && crypto.timingSafeEqual(expected, given)
      );
    },

    load,
    prune
  };
};

export const remoteMediaCache = createRemoteMediaCache({
  dir: config.storage.remoteMediaDir,
  maxBytes: config.remoteMedia.maxBytes,
  maxAgeMs: config.remoteMedia.maxAgeMs
});

/**
 * A post with its preview and sample pointed at this server's cache, when its
 * engine asks for that; otherwise the post unchanged.
 */
export const withCachedMedia = <
  T extends { previewUrl: string | null; sampleUrl: string | null }
>(
  post: T,
  engine: Pick<BooruEngineModule, 'proxiesPreviews'>
): T =>
  engine.proxiesPreviews
    ? {
        ...post,
        previewUrl: remoteMediaCache.signedPath(post.previewUrl),
        sampleUrl: remoteMediaCache.signedPath(post.sampleUrl)
      }
    : post;
