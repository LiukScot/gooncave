import fs from 'fs';
import os from 'os';
import path from 'path';

import ffmpeg, { ffprobe } from 'fluent-ffmpeg';
import { lookup as lookupMime } from 'mime-types';
import { FormData, fetch } from 'undici';

import { FileRecord, dataStore } from '../lib/dataStore';

import { resolveCredential } from './credentials';

const resolveFileUserId = async (file: FileRecord) => {
  const user = await dataStore.findUserByFileId(file.id);
  return user?.id;
};

type ProviderResult = {
  score: number | null;
  sourceUrl: string | null;
  thumbUrl: string | null;
  results?: {
    sourceUrl: string | null;
    score: number | null;
    distance?: number | null;
    sourceName: string | null;
    thumbUrl: string | null;
  }[];
  debug?: {
    rawScore: number | null;
    rawDistance: number | null;
    similarity: number | null;
  };
  error?: string;
};

type UploadSource = {
  sourcePath: string;
  filename: string;
  mimeType: string;
  cleanup: () => Promise<void>;
};

type ResolvedPath = {
  sourcePath: string;
  cleanup: () => Promise<void>;
};

type SauceNaoHeader = {
  similarity?: string | null;
  thumbnail?: string | null;
  index_name?: string | null;
  minimum_similarity?: string | number | null;
  short_remaining?: string | number | null;
  long_remaining?: string | number | null;
};

type SauceNaoData = {
  e621_id?: number | string | null;
  e621Id?: number | string | null;
  danbooru_id?: number | string | null;
  danbooruId?: number | string | null;
  ext_urls?: string[] | null;
  source?: string | null;
};

type SauceNaoMatch = {
  header?: SauceNaoHeader | null;
  data?: SauceNaoData | null;
};

type SauceNaoResponse = {
  header?: SauceNaoHeader | null;
  results?: SauceNaoMatch[] | null;
};

type FluffleMatch = {
  score?: number | null;
  distance?: number | null;
  url?: string | null;
  platform?: string | null;
  thumbnail?: {
    url?: string | null;
  } | null;
};

type FluffleResponse = {
  results?: FluffleMatch[] | null;
};

const noopCleanup = async () => undefined;

const resolveReadablePath = async (candidate: string | null | undefined) => {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  try {
    await fs.promises.access(resolved, fs.constants.R_OK);
    return resolved;
  } catch {
    return null;
  }
};

const cleanupTempFile = async (filePath: string) => {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // ignore
  }
  try {
    await fs.promises.rmdir(path.dirname(filePath));
  } catch {
    // ignore
  }
};

const getVideoDurationSeconds = async (filePath: string) => {
  return new Promise<number>((resolve) => {
    ffprobe(filePath, (err: Error | undefined, data) => {
      if (err) {
        resolve(0);
        return;
      }
      resolve(data.format.duration ?? 0);
    });
  });
};

const pickRandomTimemark = (durationSeconds: number) => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return '0.5';
  }
  const start = Math.min(durationSeconds * 0.1, Math.max(durationSeconds - 0.25, 0));
  const end = Math.max(start, durationSeconds * 0.9);
  const offset = end > start ? Math.random() * (end - start) : 0;
  return (start + offset).toFixed(3);
};

const extractRandomVideoFrame = async (videoPath: string): Promise<ResolvedPath> => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'imagesearch-frame-'));
  const framePath = path.join(tmpDir, 'frame.jpg');
  const timemark = pickRandomTimemark(await getVideoDurationSeconds(videoPath));

  await new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .screenshots({
        timemarks: [timemark],
        folder: tmpDir,
        filename: 'frame.jpg',
        size: '960x?'
      });
  });

  await fs.promises.access(framePath, fs.constants.R_OK);
  return {
    sourcePath: framePath,
    cleanup: async () => cleanupTempFile(framePath)
  };
};

const resolveUploadSource = async (file: FileRecord): Promise<UploadSource> => {
  if (file.mediaType === 'VIDEO') {
    const localVideoPath = await resolveReadablePath(file.path);
    const resolvedVideo: ResolvedPath | null = localVideoPath
      ? { sourcePath: localVideoPath, cleanup: noopCleanup }
      : null;

    if (resolvedVideo) {
      try {
        const extractedFrame = await extractRandomVideoFrame(resolvedVideo.sourcePath);
        return {
          sourcePath: extractedFrame.sourcePath,
          filename: `${path.parse(file.path).name || 'video'}-frame.jpg`,
          mimeType: 'image/jpeg',
          cleanup: async () => {
            await extractedFrame.cleanup();
            await resolvedVideo.cleanup();
          }
        };
      } catch {
        await resolvedVideo.cleanup();
      }
    }

    const fallbackThumb = await resolveReadablePath(file.thumbPath);
    if (fallbackThumb) {
      const filename = path.basename(fallbackThumb) || 'thumb.jpg';
      return {
        sourcePath: fallbackThumb,
        filename,
        mimeType: (lookupMime(filename) || 'image/jpeg') as string,
        cleanup: noopCleanup
      };
    }

    throw new Error('No readable source for provider upload');
  }

  const candidates = [file.thumbPath, file.path].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const resolved = await resolveReadablePath(candidate);
    if (!resolved) continue;
    const filename = path.basename(resolved) || 'file';
    const mimeType = (lookupMime(filename) || 'application/octet-stream') as string;
    return { sourcePath: resolved, filename, mimeType, cleanup: noopCleanup };
  }
  const fallback = path.resolve(file.path);
  const filename = path.basename(fallback) || 'file';
  const mimeType = (lookupMime(filename) || 'application/octet-stream') as string;
  return { sourcePath: fallback, filename, mimeType, cleanup: noopCleanup };
};

const pickSauceUrl = (urls: string[] | null | undefined) => {
  if (!Array.isArray(urls) || urls.length === 0) return null;
  const prefer = urls.find((url) => /e621\.net\/(?:posts|post\/show)\/\d+/i.test(url))
    ?? urls.find((url) => /danbooru\.donmai\.us\/(?:posts|post\/show)\/\d+/i.test(url));
  return prefer ?? urls[0] ?? null;
};

const pickSaucePostUrl = (data: SauceNaoData | null | undefined) => {
  const e621Id = data?.e621_id ?? data?.e621Id ?? null;
  const danbooruId = data?.danbooru_id ?? data?.danbooruId ?? null;
  const toId = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString();
    if (typeof value === 'string' && value.trim()) return value.trim();
    return null;
  };
  const e621 = toId(e621Id);
  if (e621) return `https://e621.net/posts/${e621}`;
  const danbooru = toId(danbooruId);
  if (danbooru) return `https://danbooru.donmai.us/posts/${danbooru}`;
  return null;
};

export const runSauceNao = async (file: FileRecord): Promise<ProviderResult> => {
  const credential = await resolveCredential('SAUCENAO', await resolveFileUserId(file));
  const apiKey = credential.apiKey ?? '';
  try {
    const upload = await resolveUploadSource(file);
    try {
      // Send parameters inside the multipart body to avoid SauceNAO ignoring the upload.
      const form = new FormData();
      form.append('output_type', '2'); // JSON
      form.append('numres', '6');
      form.append('db', '999');
      form.append('dedupe', '2');
      if (apiKey) form.append('api_key', apiKey);
      form.append('file', await fs.openAsBlob(upload.sourcePath, { type: upload.mimeType }), upload.filename);

      const res = await fetch('https://saucenao.com/search.php', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ImageSearch/0.1 (+local)'
          },
          body: form
      });
      const text = await res.text();
      if (!res.ok) {
        return { score: null, sourceUrl: null, thumbUrl: null, error: `HTTP ${res.status}: ${text}` };
      }
        let data: SauceNaoResponse;
      try {
          data = JSON.parse(text) as SauceNaoResponse;
      } catch {
        return { score: null, sourceUrl: null, thumbUrl: null, error: `Non-JSON response (status ${res.status}): ${text}` };
      }
      const header = data?.header ?? {};
        const results = Array.isArray(data.results) ? data.results : [];
      if (!results.length) {
        return {
          score: null,
          sourceUrl: null,
          thumbUrl: null,
          error: `No results (status:${res.status} minSim:${header.minimum_similarity ?? 'n/a'} shortRemaining:${
            header.short_remaining ?? 'n/a'
          } longRemaining:${header.long_remaining ?? 'n/a'} body:${text}`
        };
      }

      const pick = results.reduce((best, current) => {
        const sim = Number.parseFloat(current?.header?.similarity ?? '0');
        const bestSim = Number.parseFloat(best?.header?.similarity ?? '0');
        return sim > bestSim ? current : best;
      }, results[0]);

      const score = Number.parseFloat(pick?.header?.similarity ?? '0');
      const sourceUrl =
        pickSaucePostUrl(pick?.data) ?? pickSauceUrl(pick?.data?.ext_urls) ?? pick?.data?.source ?? null;
      const thumbUrl = pick?.header?.thumbnail ?? null;

      const sorted = results
        .map((r) => {
          const sim = Number.parseFloat(r?.header?.similarity ?? '0');
          const url = pickSaucePostUrl(r?.data) ?? pickSauceUrl(r?.data?.ext_urls) ?? r?.data?.source ?? null;
          let name = r?.header?.index_name ?? null;
          if (!name && url) {
            try {
              name = new URL(url).hostname.replace(/^www\./, '');
            } catch {
              name = null;
            }
          }
          return {
            score: Number.isFinite(sim) ? sim : null,
            sourceUrl: url,
            sourceName: name,
            thumbUrl: r?.header?.thumbnail ?? null
          };
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      if (!sourceUrl) {
        return {
          score: Number.isFinite(score) ? score : null,
          sourceUrl: null,
          thumbUrl,
          results: sorted,
          error: 'No source URL in result'
        };
      }

      return { score: Number.isFinite(score) ? score : null, sourceUrl, thumbUrl, results: sorted };
    } finally {
      await upload.cleanup();
    }
  } catch (err) {
    return { score: null, sourceUrl: null, thumbUrl: null, error: (err as Error).message };
  }
};

export const runFluffle = async (file: FileRecord): Promise<ProviderResult> => {
  try {
    const upload = await resolveUploadSource(file);
    try {
      const form = new FormData();
      form.append('File', await fs.openAsBlob(upload.sourcePath, { type: upload.mimeType }), upload.filename);
      form.append('Limit', '8');

      const res = await fetch('https://api.fluffle.xyz/exact-search-by-file', {
        method: 'POST',
        headers: {
          'User-Agent': 'ImageSearch/0.1 (by local)',
          Accept: 'application/json'
          },
          body: form
      });
      const text = await res.text();
      if (!res.ok) {
        return { score: null, sourceUrl: null, thumbUrl: null, error: `HTTP ${res.status}: ${text}` };
      }
        let data: FluffleResponse;
      try {
          data = JSON.parse(text) as FluffleResponse;
      } catch {
        return { score: null, sourceUrl: null, thumbUrl: null, error: `Non-JSON response: ${text}` };
      }
        const results = Array.isArray(data.results) ? data.results : [];
      if (!results.length) {
        return { score: null, sourceUrl: null, thumbUrl: null, results: [], error: 'No results returned' };
      }

      const mapped = results.map((r) => {
        const rawScore = typeof r?.score === 'number' ? r.score : null;
        const rawDistance = typeof r?.distance === 'number' ? r.distance : null;
        let similarity: number | null = null;
        if (rawScore !== null) {
          const normalized = rawScore > 1 ? rawScore / 100 : rawScore;
          similarity = Math.min(1, Math.max(0, normalized));
        } else if (rawDistance !== null) {
          const normalized = rawDistance > 1 ? rawDistance / 100 : rawDistance;
          similarity = Math.min(1, Math.max(0, normalized));
        }
        const score = similarity !== null ? Math.max(0, Math.round(similarity * 100)) : null;
        const distance = similarity !== null ? Math.max(0, Math.round((1 - similarity) * 100)) : null;
        return {
          score,
          distance,
          sourceUrl: r?.url ?? null,
          sourceName: r?.platform ?? null,
          thumbUrl: r?.thumbnail?.url ?? null,
          rawScore,
          rawDistance,
          similarity
        };
      });

      const sorted = mapped.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const top = sorted[0];
      const debug = top
        ? {
            rawScore: top.rawScore ?? null,
            rawDistance: top.rawDistance ?? null,
            similarity: top.similarity ?? null
          }
        : undefined;

      return {
        score: top?.score ?? null,
        sourceUrl: top?.sourceUrl ?? null,
        thumbUrl: top?.thumbUrl ?? null,
          results: sorted.map((item) => ({
            score: item.score,
            distance: item.distance,
            sourceUrl: item.sourceUrl,
            sourceName: item.sourceName,
            thumbUrl: item.thumbUrl
          })),
        debug
      };
    } finally {
      await upload.cleanup();
    }
  } catch (err) {
    return { score: null, sourceUrl: null, thumbUrl: null, error: (err as Error).message };
  }
};
