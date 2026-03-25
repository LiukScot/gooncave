import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';

import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import { createClient } from 'webdav';

import { dataStore } from './dataStore';
import type { FavoriteProvider, FileRecord, FolderRecord } from './dataStore';
import type { MediaKind } from './scanner';

export type DuplicateScanOptions = {
  mediaType?: MediaKind | 'ALL';
  pixelThreshold?: number;
  sampleSize?: number;
  videoFrames?: number;
  maxComparisons?: number;
};

export type DuplicateFileSummary = {
  id: string;
  folderId: string;
  path: string;
  mediaType: MediaKind;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbUrl: string | null;
  favoriteProviders: FavoriteProvider[];
};

export type DuplicateGroup = {
  key: string;
  files: DuplicateFileSummary[];
};

export type DuplicateScanProgress = {
  phase: string;
  processed: number;
  total: number;
  comparisons: number;
  groups: number;
  skippedNoSignature: number;
  message: string;
};

export type DuplicateScanResult = {
  groups: DuplicateGroup[];
  stats: {
    totalFiles: number;
    eligibleFiles: number;
    comparedFiles: number;
    comparisons: number;
    skippedNoSignature: number;
    pixelThreshold: number;
  };
};

type ImageSignature = { kind: 'IMAGE'; buffer: Uint8Array };
type VideoSignature = { kind: 'VIDEO'; frames: Uint8Array[] };
type PixelSignature = ImageSignature | VideoSignature;

type ResolvedPath = { path: string; cleanup: () => Promise<void> };

const defaultOptions = {
  mediaType: 'ALL' as const,
  pixelThreshold: 0.02,
  sampleSize: 64,
  videoFrames: 3,
  maxComparisons: 2000
};

const MAX_SIZE_NEIGHBOR_OFFSETS = 12;
const SMALL_GROUP_FULL_COMPARE_LIMIT = 120;

const thumbUrlFor = (thumbPath: string | null) => {
  if (!thumbPath) return null;
  return `/thumbnails/${path.basename(thumbPath)}`;
};

const sanitizeBasename = (value: string, fallback = 'file') => {
  const base = path.basename(value || '');
  if (!base || base === '.' || base === '..') return fallback;
  return base.replace(/[\\/:*?"<>|]/g, '_');
};

const resolvePathInDir = (baseDir: string, childName: string) => {
  const normalizedBase = path.normalize(baseDir);
  const normalizedChild = path.normalize(childName);
  const basePrefix = normalizedBase.endsWith(path.sep) ? normalizedBase : `${normalizedBase}${path.sep}`;
  const resolvedChild = normalizedChild.startsWith(path.sep)
    ? normalizedChild
    : `${basePrefix}${normalizedChild}`;
  const guardedChild = path.normalize(resolvedChild);
  if (guardedChild !== normalizedBase && !guardedChild.startsWith(basePrefix)) {
    throw new Error('Resolved path escapes temp directory');
  }
  return guardedChild;
};

const downloadToTemp = async (client: ReturnType<typeof createClient>, remotePath: string) => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'imagesearch-'));
  const dest = resolvePathInDir(tmp, sanitizeBasename(remotePath, 'file'));
  const read = client.createReadStream(remotePath);
  const write = fs.createWriteStream(dest);
  await pipeline(read, write);
  return { dest, dir: tmp };
};

const resolveReadablePath = async (
  file: FileRecord,
  folderById: Map<string, FolderRecord>
): Promise<ResolvedPath | null> => {
  const candidates: string[] = [];
  if (file.locationType === 'LOCAL') {
    candidates.push(file.path);
  }
  if (file.thumbPath) {
    candidates.push(file.thumbPath);
  }

  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate, fs.constants.R_OK);
      return { path: candidate, cleanup: async () => undefined };
    } catch {
      // try next candidate
    }
  }

  if (file.locationType === 'WEBDAV') {
    const folder = folderById.get(file.folderId);
    if (!folder?.webdavUrl) return null;
    const client = createClient(folder.webdavUrl, {
      username: folder.webdavUsername ?? '',
      password: folder.webdavPassword ?? ''
    });
    try {
      const { dest, dir } = await downloadToTemp(client, file.path);
      return {
        path: dest,
        cleanup: async () => {
          try {
            await fs.promises.unlink(dest);
          } catch {
            // ignore
          }
          try {
            await fs.promises.rmdir(dir);
          } catch {
            // ignore
          }
        }
      };
    } catch {
      return null;
    }
  }

  return null;
};

const buildImageSignature = async (file: FileRecord, sampleSize: number, folderById: Map<string, FolderRecord>) => {
  const resolved = await resolveReadablePath(file, folderById);
  if (!resolved) return null;
  try {
    const buffer = await sharp(resolved.path)
      .rotate()
      .resize(sampleSize, sampleSize, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer();
    return { kind: 'IMAGE', buffer: new Uint8Array(buffer) } as ImageSignature;
  } catch {
    return null;
  } finally {
    await resolved.cleanup();
  }
};

const getDurationSeconds = async (filePath: string) => {
  return new Promise<number>((resolve) => {
    ffmpeg.ffprobe(filePath, (err: Error | undefined, data) => {
      if (err) {
        resolve(0);
        return;
      }
      resolve(data.format.duration ?? 0);
    });
  });
};

const extractVideoFrames = async (filePath: string, count: number, width: number) => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'imagesearch-frames-'));
  const durationSeconds = await getDurationSeconds(filePath);
  const safeCount = Math.max(1, count);
  const stamps =
    durationSeconds > 0
      ? Array.from({ length: safeCount }, (_, idx) => ((durationSeconds * (idx + 1)) / (safeCount + 1)).toFixed(2))
      : ['1'];

  await new Promise<void>((resolve, reject) => {
    ffmpeg(filePath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .screenshots({
        timemarks: stamps,
        folder: tmp,
        filename: 'frame-%i.jpg',
        size: `${width}x?`
      });
  });

  const frames = (await fs.promises.readdir(tmp))
    .filter((name) => name.startsWith('frame-'))
    .map((name) => resolvePathInDir(tmp, sanitizeBasename(name, 'frame.jpg')));

  return {
    frames,
    cleanup: async () => {
      await Promise.all(
        frames.map(async (frame) => {
          try {
            await fs.promises.unlink(frame);
          } catch {
            // ignore
          }
        })
      );
      try {
        await fs.promises.rmdir(tmp);
      } catch {
        // ignore
      }
    }
  };
};

const buildVideoSignature = async (
  file: FileRecord,
  sampleSize: number,
  frameCount: number,
  folderById: Map<string, FolderRecord>
) => {
  const resolved = await resolveReadablePath(file, folderById);
  if (!resolved) return null;
  const frameWidth = Math.max(sampleSize * 2, 128);
  try {
    const { frames, cleanup } = await extractVideoFrames(resolved.path, frameCount, frameWidth);
    try {
      if (frames.length === 0) return null;
      const buffers = await Promise.all(
        frames.map((frame) =>
          sharp(frame).resize(sampleSize, sampleSize, { fit: 'fill' }).grayscale().raw().toBuffer()
        )
      );
      return { kind: 'VIDEO', frames: buffers.map((buffer) => new Uint8Array(buffer)) } as VideoSignature;
    } finally {
      await cleanup();
    }
  } catch {
    return null;
  } finally {
    await resolved.cleanup();
  }
};

const compareBuffers = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length || a.length === 0) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / (a.length * 255);
};

const isImageSignature = (signature: PixelSignature): signature is ImageSignature => signature.kind === 'IMAGE';
const isVideoSignature = (signature: PixelSignature): signature is VideoSignature => signature.kind === 'VIDEO';

const compareSignatures = (a: PixelSignature, b: PixelSignature) => {
  if (isImageSignature(a) && isImageSignature(b)) {
    return compareBuffers(a.buffer, b.buffer);
  }
  if (isVideoSignature(a) && isVideoSignature(b)) {
    const frames = Math.min(a.frames.length, b.frames.length);
    if (frames === 0) return 1;
    let sum = 0;
    for (let i = 0; i < frames; i += 1) {
      sum += compareBuffers(a.frames[i], b.frames[i]);
    }
    return sum / frames;
  }
  return 1;
};

const buildComparisonPairs = (files: FileRecord[], maxPairs: number) => {
  if (files.length < 2 || maxPairs <= 0) return [] as Array<[number, number]>;

  const indexed = files
    .map((file, index) => ({ file, index }))
    .sort((left, right) => {
      if (left.file.sizeBytes !== right.file.sizeBytes) return left.file.sizeBytes - right.file.sizeBytes;
      return left.file.path.localeCompare(right.file.path);
    });

  const pairs: Array<[number, number]> = [];
  const seen = new Set<string>();

  const pushPair = (a: number, b: number) => {
    if (a === b) return;
    const left = Math.min(a, b);
    const right = Math.max(a, b);
    const key = `${left}:${right}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push([left, right]);
  };

  for (let offset = 1; offset <= MAX_SIZE_NEIGHBOR_OFFSETS; offset += 1) {
    for (let i = 0; i + offset < indexed.length; i += 1) {
      pushPair(indexed[i].index, indexed[i + offset].index);
      if (pairs.length >= maxPairs) return pairs;
    }
  }

  if (files.length > SMALL_GROUP_FULL_COMPARE_LIMIT) return pairs;

  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      pushPair(i, j);
      if (pairs.length >= maxPairs) return pairs;
    }
  }

  return pairs;
};

class UnionFind {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, idx) => idx);
  }

  find(x: number): number {
    if (this.parent[x] === x) return x;
    this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }

  union(a: number, b: number) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    this.parent[rootB] = rootA;
  }
}

export const findDuplicates = async (
  options: DuplicateScanOptions = {},
  onProgress?: (progress: DuplicateScanProgress) => void
): Promise<DuplicateScanResult> => {
  const merged = { ...defaultOptions, ...options };
  const files = await dataStore.listFiles();
  const folderById = new Map((await dataStore.listFolders()).map((folder) => [folder.id, folder]));
  const favorites = await dataStore.listFavoriteItems();
  const favoritesByPath = new Map<string, Set<FavoriteProvider>>();
  for (const item of favorites) {
    const existing = favoritesByPath.get(item.filePath);
    if (existing) {
      existing.add(item.provider);
    } else {
      favoritesByPath.set(item.filePath, new Set([item.provider]));
    }
  }

  const buildSummary = (file: FileRecord): DuplicateFileSummary => ({
    id: file.id,
    folderId: file.folderId,
    path: file.path,
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    width: file.width,
    height: file.height,
    durationMs: file.durationMs,
    thumbUrl: thumbUrlFor(file.thumbPath ?? null),
    favoriteProviders: Array.from(favoritesByPath.get(file.path) ?? [])
  });

  const eligible = files.filter((file) => {
    if (merged.mediaType !== 'ALL' && file.mediaType !== merged.mediaType) return false;
    if (!file.width || !file.height) return false;
    if (!Number.isFinite(file.sizeBytes) || file.sizeBytes <= 0) return false;
    return true;
  });

  const groupsByKey = new Map<string, FileRecord[]>();
  for (const file of eligible) {
    const key = `${file.mediaType}:${file.width}x${file.height}`;
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.push(file);
    } else {
      groupsByKey.set(key, [file]);
    }
  }

  const groups: DuplicateGroup[] = [];
  let comparisons = 0;
  let comparedFiles = 0;
  let skippedNoSignature = 0;

  const groupedEntries = Array.from(groupsByKey.entries()).filter(([, groupFiles]) => groupFiles.length >= 2);

  const emitProgress = (phase: string, message: string) => {
    onProgress?.({
      phase,
      processed: comparedFiles,
      total: eligible.length,
      comparisons,
      groups: groups.length,
      skippedNoSignature,
      message
    });
  };

  emitProgress('preparing', `Found ${eligible.length} eligible files in ${groupedEntries.length} size groups`);

  for (let groupIndex = 0; groupIndex < groupedEntries.length; groupIndex += 1) {
    if (comparisons >= merged.maxComparisons) break;

    const [key, groupFiles] = groupedEntries[groupIndex];
    const signatures = new Map<string, PixelSignature>();
    for (const file of groupFiles) {
      const signature =
        file.mediaType === 'IMAGE'
          ? await buildImageSignature(file, merged.sampleSize, folderById)
          : await buildVideoSignature(file, merged.sampleSize, merged.videoFrames, folderById);
      if (!signature) {
        skippedNoSignature += 1;
        continue;
      }
      signatures.set(file.id, signature);
    }

    const candidates = groupFiles.filter((file) => signatures.has(file.id));
    if (candidates.length < 2) continue;

    const remainingBudget = merged.maxComparisons - comparisons;
    if (remainingBudget <= 0) break;
    const remainingGroups = groupedEntries.length - groupIndex;
    const groupBudget = Math.max(1, Math.floor(remainingBudget / remainingGroups));
    const pairIndexes = buildComparisonPairs(candidates, groupBudget);
    if (pairIndexes.length === 0) continue;

    comparedFiles += candidates.length;
    emitProgress('comparing', `Group ${groupIndex + 1}/${groupedEntries.length}: comparing ${candidates.length} files`);
    const uf = new UnionFind(candidates.length);

    for (const [i, j] of pairIndexes) {
      if (comparisons >= merged.maxComparisons) break;
      const sigA = signatures.get(candidates[i].id);
      const sigB = signatures.get(candidates[j].id);
      if (!sigA || !sigB) continue;
      const diff = compareSignatures(sigA, sigB);
      comparisons += 1;
      if (diff <= merged.pixelThreshold) {
        uf.union(i, j);
      }
    }

    const grouped = new Map<number, FileRecord[]>();
    for (let i = 0; i < candidates.length; i += 1) {
      const root = uf.find(i);
      const bucket = grouped.get(root);
      if (bucket) {
        bucket.push(candidates[i]);
      } else {
        grouped.set(root, [candidates[i]]);
      }
    }

    for (const bucket of grouped.values()) {
      if (bucket.length < 2) continue;
      groups.push({
        key,
        files: bucket.map(buildSummary)
      });
    }
  }

  return {
    groups,
    stats: {
      totalFiles: files.length,
      eligibleFiles: eligible.length,
      comparedFiles,
      comparisons,
      skippedNoSignature,
      pixelThreshold: merged.pixelThreshold
    }
  };
};