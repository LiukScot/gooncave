import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import ffmpeg, { ffprobe } from 'fluent-ffmpeg';
import sharp, { cache as configureSharpCache, concurrency as configureSharpConcurrency, simd as configureSharpSimd } from 'sharp';

import { FileRecord, FolderRecord } from './dataStore';

configureSharpCache(false);
configureSharpConcurrency(1);
configureSharpSimd(false);

export type MediaKind = 'IMAGE' | 'VIDEO';

const imageExt = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.avif']);
const videoExt = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.m4v']);

export const detectMediaKind = (filePath: string): MediaKind | null => {
  const ext = path.extname(filePath).toLowerCase();
  if (imageExt.has(ext)) return 'IMAGE';
  if (videoExt.has(ext)) return 'VIDEO';
  return null;
};

export type ScannedFile = {
  locationType: 'LOCAL';
  path: string;
  sizeBytes: bigint;
  mtime: Date;
  sha256: string;
  mediaType: MediaKind;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  phash: string | null;
  thumbPath: string | null;
};

export const computeSha256 = async (filePath: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
};

type WalkOptions = {
  shouldStop?: () => boolean;
  yieldEvery?: number;
};

const walk = async function* walk(dir: string, options?: WalkOptions): AsyncGenerator<string> {
  if (options?.shouldStop?.()) return;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  let processed = 0;
  for (const entry of entries) {
    if (options?.shouldStop?.()) return;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath, options);
    } else if (entry.isFile()) {
      yield fullPath;
    }
    processed += 1;
    if (options?.yieldEvery && processed % options.yieldEvery === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
};

export const iterateLocalMediaPaths = async function* (
  folderPath: string,
  options?: WalkOptions
): AsyncGenerator<string> {
  for await (const filePath of walk(folderPath, options)) {
    if (options?.shouldStop?.()) return;
    if (!detectMediaKind(filePath)) continue;
    yield filePath;
  }
};

export const listLocalMediaPaths = async (folderPath: string): Promise<string[]> => {
  const results: string[] = [];
  for await (const filePath of iterateLocalMediaPaths(folderPath)) {
    results.push(filePath);
  }
  return results;
};

const averageHash = async (filePath: string): Promise<string> => {
  const img = sharp(filePath).rotate().resize(8, 8, { fit: 'fill' }).grayscale();
  const { data } = await img.raw().toBuffer({ resolveWithObject: true });
  const pixels = Array.from(data);
  const mean = pixels.reduce((acc, v) => acc + v, 0) / pixels.length;
  const bits = pixels.map((v) => (v > mean ? 1 : 0));
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    hex += nibble.toString(16);
  }
  return hex;
};

const getImageMeta = async (filePath: string) => {
  const meta = await sharp(filePath).rotate().metadata();
  return {
    width: meta.width ?? null,
    height: meta.height ?? null
  };
};

const makeThumbnail = async (filePath: string, thumbDir: string, nameHint: string): Promise<string> => {
  await fs.promises.mkdir(thumbDir, { recursive: true });
  const outName = `${nameHint}.jpg`;
  const outPath = path.join(thumbDir, outName);
  await sharp(filePath).rotate().resize(400, 400, { fit: 'inside' }).jpeg({ quality: 70 }).toFile(outPath);
  return outPath;
};

const getVideoMeta = (
  filePath: string
): Promise<{ width: number | null; height: number | null; durationMs: number | null }> => {
  return new Promise((resolve) => {
    ffprobe(filePath, (err: Error | undefined, data) => {
      if (err) {
        resolve({ width: null, height: null, durationMs: null });
        return;
      }
      const stream = data.streams.find((s) => s.width && s.height);
      resolve({
        width: stream?.width ?? null,
        height: stream?.height ?? null,
        durationMs: data.format.duration ? data.format.duration * 1000 : null
      });
    });
  });
};

const makeVideoThumbnail = async (filePath: string, thumbDir: string, nameHint: string): Promise<string | null> => {
  await fs.promises.mkdir(thumbDir, { recursive: true });
  const outName = `${nameHint}.jpg`;
  const outPath = path.join(thumbDir, outName);
  return new Promise((resolve) => {
    ffmpeg(filePath)
      .seekInput('00:00:01')
      .on('end', () => resolve(outPath))
      .on('error', () => resolve(null))
      .screenshots({
        count: 1,
        folder: thumbDir,
        filename: outName,
        size: '400x?'
      });
  });
};

type ScanOptions = {
  thumbnailsDir?: string;
  existingFiles?: Map<string, FileRecord>;
};

export const scanLocalFile = async (filePath: string, options: ScanOptions = {}): Promise<ScannedFile | null> => {
  const mediaType = detectMediaKind(filePath);
  if (!mediaType) return null;

  const stats = await fs.promises.stat(filePath);
  const existing = options.existingFiles?.get(filePath);
  if (
    existing &&
    Number(existing.sizeBytes) === stats.size &&
    new Date(existing.mtime).getTime() === stats.mtimeMs
  ) {
    return {
      locationType: 'LOCAL',
      path: filePath,
      sizeBytes: BigInt(stats.size),
      mtime: new Date(stats.mtimeMs),
      sha256: existing.sha256,
      mediaType,
      width: existing.width,
      height: existing.height,
      durationMs: existing.durationMs,
      phash: existing.phash,
      thumbPath: existing.thumbPath
    };
  }

  const sha256 = await computeSha256(filePath);
  let width: number | null = null;
  let height: number | null = null;
  let durationMs: number | null = null;
  let phash: string | null = null;
  let thumbPath: string | null = null;

  if (mediaType === 'IMAGE') {
    try {
      const meta = await getImageMeta(filePath);
      width = meta.width;
      height = meta.height;
    } catch {
      // ignore
    }
    try {
      phash = await averageHash(filePath);
    } catch {
      phash = null;
    }
    if (options.thumbnailsDir) {
      try {
        const outPath = await makeThumbnail(filePath, options.thumbnailsDir, sha256.slice(0, 12));
        thumbPath = outPath;
      } catch {
        thumbPath = null;
      }
    }
  } else if (mediaType === 'VIDEO') {
    try {
      const meta = await getVideoMeta(filePath);
      width = meta.width;
      height = meta.height;
      durationMs = meta.durationMs;
    } catch {
      // ignore
    }
    if (options.thumbnailsDir) {
      try {
        const outPath = await makeVideoThumbnail(filePath, options.thumbnailsDir, sha256.slice(0, 12));
        thumbPath = outPath;
      } catch {
        thumbPath = null;
      }
    }
  }

  return {
    locationType: 'LOCAL',
    path: filePath,
    sizeBytes: BigInt(stats.size),
    mtime: new Date(stats.mtimeMs),
    sha256,
    mediaType,
    width,
    height,
    durationMs,
    phash,
    thumbPath
  };
};

const scanLocalFolder = async (folderPath: string, options: ScanOptions = {}): Promise<ScannedFile[]> => {
  const results: ScannedFile[] = [];
  for await (const filePath of walk(folderPath)) {
    const mediaType = detectMediaKind(filePath);
    if (!mediaType) continue;

    const stats = await fs.promises.stat(filePath);
    const existing = options.existingFiles?.get(filePath);
    if (
      existing &&
      Number(existing.sizeBytes) === stats.size &&
      new Date(existing.mtime).getTime() === stats.mtimeMs
    ) {
      results.push({
        locationType: 'LOCAL',
        path: filePath,
        sizeBytes: BigInt(stats.size),
        mtime: new Date(stats.mtimeMs),
        sha256: existing.sha256,
        mediaType,
        width: existing.width,
        height: existing.height,
        durationMs: existing.durationMs,
        phash: existing.phash,
        thumbPath: existing.thumbPath
      });
      continue;
    }
    const sha256 = await computeSha256(filePath);

    let width: number | null = null;
    let height: number | null = null;
    let durationMs: number | null = null;
    let phash: string | null = null;
    let thumbPath: string | null = null;

    if (mediaType === 'IMAGE') {
      try {
        const meta = await getImageMeta(filePath);
        width = meta.width;
        height = meta.height;
      } catch {
        // ignore
      }
      try {
        phash = await averageHash(filePath);
      } catch {
        phash = null;
      }
      if (options.thumbnailsDir) {
        try {
          const outPath = await makeThumbnail(filePath, options.thumbnailsDir, sha256.slice(0, 12));
          thumbPath = outPath;
        } catch {
          thumbPath = null;
        }
      }
    } else if (mediaType === 'VIDEO') {
      try {
        const meta = await getVideoMeta(filePath);
        width = meta.width;
        height = meta.height;
        durationMs = meta.durationMs;
      } catch {
        // ignore
      }
      if (options.thumbnailsDir) {
        try {
          const outPath = await makeVideoThumbnail(filePath, options.thumbnailsDir, sha256.slice(0, 12));
          thumbPath = outPath;
        } catch {
          thumbPath = null;
        }
      }
    }

    results.push({
      locationType: 'LOCAL',
      path: filePath,
      sizeBytes: BigInt(stats.size),
      mtime: new Date(stats.mtimeMs),
      sha256,
      mediaType,
      width,
      height,
      durationMs,
      phash,
      thumbPath
    });
  }

  return results;
};

export const scanFolder = async (folder: FolderRecord, options: ScanOptions = {}): Promise<ScannedFile[]> => {
  return scanLocalFolder(folder.path, options);
};
