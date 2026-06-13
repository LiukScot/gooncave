import { Blob } from 'buffer';
import fs from 'fs';
import os from 'os';
import path from 'path';

import ffmpeg, { ffprobe } from 'fluent-ffmpeg';
import sharp from 'sharp';
import { FormData, fetch } from 'undici';

import { config } from '../config';
import { authRepo } from '../db/repos/authRepo';
import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { filesRepo } from '../db/repos/filesRepo';
import { BooruSiteRecord, SPECIAL_TAG_SOURCES, TagSource } from '../db/types';
import type { FileRecord, ProviderRunRecord } from '../db/types';
import { engineSupports, getEngine } from '../lib/booruEngines';

type TagCandidate = {
  site: BooruSiteRecord;
  id: string;
  idKind?: 'POST' | 'MD5';
  url: string;
  score: number;
};

const tagSourceForSite = (site: BooruSiteRecord): TagSource =>
  site.presetKey ?? site.id;

type TagResult = {
  tag: string;
  category: string;
  score?: number | null;
  sourceUrl?: string | null;
};

type Wd14Tag = {
  tag: string;
  score: number;
  category: string;
};

type Wd14Response = {
  tags?: Wd14Tag[] | null;
};

const providerScoreThresholds: Record<ProviderRunRecord['provider'], number> = {
  SAUCENAO: 90,
  FLUFFLE: 95
};

const resolveFileUserId = async (fileId: string) => {
  const user = await authRepo.findUserByFileId(fileId);
  return user?.id;
};

const resolveCandidateScore = (
  run: ProviderRunRecord,
  result: { score?: number | null; distance?: number | null }
) => {
  if (run.provider !== 'FLUFFLE') {
    return typeof result.score === 'number' ? result.score : 0;
  }
  if (typeof result.score === 'number') {
    return result.score;
  }
  if (typeof result.distance === 'number') {
    return result.distance;
  }
  return 0;
};

const md5Regex = /\b[a-f0-9]{32}\b/;

const resolveMd5 = (value: string | null | undefined) => {
  if (!value) return null;
  const match = value.match(md5Regex);
  return match ? match[0].toLowerCase() : null;
};

const resolveSiteFromName = (
  value: string,
  sites: BooruSiteRecord[]
): BooruSiteRecord | null => {
  const lower = value.toLowerCase();
  for (const site of sites) {
    const presetKey = site.presetKey?.toLowerCase();
    if (presetKey && lower.includes(presetKey)) return site;
    if (site.name && lower.includes(site.name.toLowerCase())) return site;
  }
  return null;
};

// Per-user, engine-driven URL → site resolver. Replaces the static
// e621Regex/danbooruRegex/... cascade. Iterates the user's enabled sites
// whose engine supports tag fetch, in sort order, and asks each engine if
// the URL belongs to it.
const resolveTagCandidate = (
  url: string | null | undefined,
  score: number,
  sourceName: string | null | undefined,
  sites: BooruSiteRecord[]
): TagCandidate | null => {
  const eligible = sites
    .filter((site) => site.enabled && engineSupports(site.engine, 'tags'))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  if (url) {
    for (const site of eligible) {
      const engine = getEngine(site.engine);
      if (!engine) continue;
      const match = engine.extractIdFromUrl(url, site);
      if (match) {
        return { site, id: match.remoteId, idKind: 'POST', url, score };
      }
    }
    // md5-based fallback: try to identify site from name (e.g. SauceNAO
    // "Index #29: e621") then look up the post by md5 on that site.
    const md5 = resolveMd5(url) ?? resolveMd5(sourceName ?? null);
    if (md5) {
      const site = sourceName
        ? resolveSiteFromName(sourceName, eligible)
        : null;
      if (site) {
        return { site, id: md5, idKind: 'MD5', url, score };
      }
    }
  }
  const md5 = resolveMd5(url ?? null) ?? resolveMd5(sourceName ?? null);
  if (md5) {
    const site = sourceName ? resolveSiteFromName(sourceName, eligible) : null;
    if (site) {
      return { site, id: md5, idKind: 'MD5', url: url ?? '', score };
    }
  }
  return null;
};

// Tag parsing moved into engine modules (lib/booruEngines).

const extractCandidates = (
  run: ProviderRunRecord,
  sites: BooruSiteRecord[]
): TagCandidate[] => {
  const minScore = providerScoreThresholds[run.provider] ?? 0;
  const results =
    run.results && run.results.length
      ? run.results
      : run.sourceUrl
        ? [{ sourceUrl: run.sourceUrl, score: run.score }]
        : [];
  const picks = new Map<string, TagCandidate>();

  for (const result of results) {
    const score = resolveCandidateScore(run, result);
    if (score < minScore) continue;
    const url = result.sourceUrl ?? null;
    const sourceName =
      (result as { sourceName?: string | null }).sourceName ?? null;
    const candidate = resolveTagCandidate(url, score, sourceName, sites);
    if (!candidate) continue;
    const key = tagSourceForSite(candidate.site);
    const existing = picks.get(key);
    if (!existing || score > existing.score) {
      picks.set(key, candidate);
    }
  }

  return Array.from(picks.values());
};

const collectCandidatesFromRuns = (
  runs: ProviderRunRecord[],
  sites: BooruSiteRecord[]
) => {
  const picks = new Map<string, TagCandidate>();
  for (const run of runs) {
    if (run.status !== 'COMPLETED') continue;
    const candidates = extractCandidates(run, sites);
    for (const candidate of candidates) {
      const key = tagSourceForSite(candidate.site);
      const existing = picks.get(key);
      if (!existing || candidate.score > existing.score) {
        picks.set(key, candidate);
      }
    }
  }
  return Array.from(picks.values());
};

// Tag fetching is now handled by engine modules in lib/booruEngines. The
// legacy fetchE621Tags / fetchDanbooruTags / fetchGelbooruTags /
// fetchMoebooruTags / fetchSankakuTags wrappers were removed in favor of
// `engine.fetchPostTags(site, postId)` / `engine.fetchPostByMd5(site, md5)`.

const fetchTagsBySite = async (
  site: BooruSiteRecord,
  candidate: TagCandidate
): Promise<{ tags: TagResult[]; sourceUrl: string | null }> => {
  const engine = getEngine(site.engine);
  if (!engine) return { tags: [], sourceUrl: null };
  if (candidate.idKind === 'MD5') {
    if (!engine.fetchPostByMd5) return { tags: [], sourceUrl: null };
    const result = await engine.fetchPostByMd5(site, candidate.id);
    return result ?? { tags: [], sourceUrl: null };
  }
  const tags = await engine.fetchPostTags(site, candidate.id);
  return {
    tags,
    sourceUrl: candidate.url || engine.buildPostUrl(site, candidate.id)
  };
};

const resolveLocalPath = async (file: FileRecord) => {
  return { path: file.path, cleanup: async () => undefined };
};

const runWd14Tagger = async (imagePath: string) => {
  const normalized = await sharp(imagePath).rotate().png().toBuffer();
  const imageBytes = Uint8Array.from(normalized);
  const form = new FormData();
  form.set(
    'file',
    new Blob([imageBytes], { type: 'image/png' }),
    `${path.parse(imagePath).name}.png`
  );
  const headers: Record<string, string> = {};
  if (config.tagger.secret) {
    headers['X-Tagger-Token'] = config.tagger.secret;
  }
  const res = await fetch(`${config.tagger.url}/tag`, {
    method: 'POST',
    body: form,
    headers
  });
  if (!res.ok) {
    throw new Error(`tagger error: ${res.status}`);
  }
  const data = (await res.json()) as Wd14Response;
  return Array.isArray(data.tags) ? data.tags : [];
};

const extractVideoFrames = async (filePath: string, count: number) => {
  const tmp = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'imagesearch-frames-')
  );
  const durationSeconds = await new Promise<number>((resolve) => {
    ffprobe(filePath, (err, data) => {
      if (err) {
        resolve(0);
        return;
      }
      resolve(data.format.duration ?? 0);
    });
  });
  const stamps =
    durationSeconds > 0
      ? Array.from({ length: count }, (_, idx) =>
          ((durationSeconds * (idx + 1)) / (count + 1)).toFixed(2)
        )
      : ['1'];
  await new Promise<void>((resolve, reject) => {
    ffmpeg(filePath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .screenshots({
        timemarks: stamps,
        folder: tmp,
        filename: 'frame-%i.jpg',
        size: '512x?'
      });
  });
  const frames = (await fs.promises.readdir(tmp))
    .filter((name) => name.startsWith('frame-'))
    .map((name) => path.join(tmp, name));
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

const mergeTagScores = (
  sets: { tag: string; score: number; category: string }[][]
) => {
  const map = new Map<
    string,
    { tag: string; score: number; category: string }
  >();
  for (const tags of sets) {
    for (const item of tags) {
      const key = `${item.category}:${item.tag}`;
      const existing = map.get(key);
      if (!existing || item.score > existing.score) {
        map.set(key, item);
      }
    }
  }
  return Array.from(map.values());
};

const dedupeTags = (tags: TagResult[]) => {
  const map = new Map<string, TagResult>();
  for (const item of tags) {
    const key = `${item.category}:${item.tag}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      continue;
    }
    const existingScore =
      typeof existing.score === 'number' ? existing.score : -Infinity;
    const nextScore = typeof item.score === 'number' ? item.score : -Infinity;
    if (nextScore > existingScore) {
      map.set(key, { ...existing, ...item });
      continue;
    }
    if (!existing.sourceUrl && item.sourceUrl) {
      map.set(key, { ...existing, sourceUrl: item.sourceUrl });
    }
  }
  return Array.from(map.values());
};

const replaceTags = async (
  fileId: string,
  source: TagSource,
  tags: TagResult[],
  sourceUrl?: string
) => {
  const uniqueTags = dedupeTags(tags);
  await filesRepo.replaceTagsForSource(
    fileId,
    source,
    uniqueTags.map((tag) => ({
      tag: tag.tag,
      category: tag.category,
      score: tag.score ?? null,
      sourceUrl: tag.sourceUrl ?? sourceUrl ?? null
    }))
  );
};

// Legacy entry point kept for favorites.ts. `provider` is either a legacy
// preset key ('E621'/'DANBOORU') or a user_booru_sites.id UUID. Resolves the
// site from the caller's perspective (via file owner) and dispatches to the
// engine module.
export const applyRemotePostTags = async (
  file: FileRecord,
  provider: string,
  postId: string,
  sourceUrl?: string | null
) => {
  const userId = await resolveFileUserId(file.id);
  if (!userId) return { applied: false, count: 0 };
  const byId = await booruSitesRepo.getBooruSite(provider, userId);
  const site =
    byId ?? (await booruSitesRepo.findBooruSiteByPresetKey(provider, userId));
  if (!site) return { applied: false, count: 0 };
  const engine = getEngine(site.engine);
  if (!engine) return { applied: false, count: 0 };
  const tags = await engine.fetchPostTags(site, postId);
  if (!tags.length) return { applied: false, count: 0 };
  const resolvedUrl = sourceUrl ?? engine.buildPostUrl(site, postId);
  await replaceTags(file.id, tagSourceForSite(site), tags, resolvedUrl);
  return { applied: true, count: tags.length };
};

const applyCandidateTags = async (fileId: string, candidate: TagCandidate) => {
  const { tags, sourceUrl } = await fetchTagsBySite(candidate.site, candidate);
  if (!tags.length) return false;
  await replaceTags(
    fileId,
    tagSourceForSite(candidate.site),
    tags,
    sourceUrl ?? candidate.url
  );
  return true;
};

const applyCombinedTags = async (
  file: FileRecord,
  candidates: TagCandidate[]
) => {
  for (const candidate of candidates) {
    await applyCandidateTags(file.id, candidate);
  }
  await ensureWd14Tags(file, file.mediaType === 'VIDEO', { force: true });
};

const loadTagSitesForFile = async (
  file: FileRecord
): Promise<BooruSiteRecord[]> => {
  const userId = await resolveFileUserId(file.id);
  if (!userId) return [];
  return booruSitesRepo.listBooruSites(userId);
};

export const refreshTagsFromProviderRun = async (
  file: FileRecord,
  _run: ProviderRunRecord
) => {
  void _run;
  try {
    const sites = await loadTagSitesForFile(file);
    const runs = await filesRepo.listProviderRuns(file.id);
    const candidates = collectCandidatesFromRuns(runs, sites);
    await applyCombinedTags(file, candidates);
  } catch (err) {
    console.warn(
      `[tags] refresh failed for ${file.id}: ${(err as Error).message}`
    );
  }
};

export const ensureWd14Tags = async (
  file: FileRecord,
  forceForVideo: boolean,
  options?: { force?: boolean; ignoreSourceTags?: boolean }
) => {
  if (!config.tagger.url) return;
  if (file.mediaType === 'IMAGE' && (!file.width || !file.height)) return;
  const tags = await filesRepo.listTagsForFile(file.id);
  const specialSources = new Set<string>(SPECIAL_TAG_SOURCES);
  const hasSourceTags = tags.some((tag) => !specialSources.has(tag.source));
  const hasWd14 = tags.some((tag) => tag.source === 'WD14');
  if (hasWd14 && !options?.force) return;
  if (
    !forceForVideo &&
    hasSourceTags &&
    !options?.force &&
    !options?.ignoreSourceTags
  )
    return;

  const resolved = await resolveLocalPath(file);
  if (!resolved) return;
  try {
    if (file.mediaType === 'VIDEO') {
      const { frames, cleanup } = await extractVideoFrames(resolved.path, 3);
      try {
        const results = await Promise.all(
          frames.map((frame) => runWd14Tagger(frame))
        );
        const merged = mergeTagScores(results);
        await replaceTags(file.id, 'WD14', merged);
      } finally {
        await cleanup();
      }
    } else {
      const tagsFromModel = await runWd14Tagger(resolved.path);
      await replaceTags(file.id, 'WD14', tagsFromModel);
    }
  } catch (err) {
    console.warn(
      `[tags] wd14 failed for ${file.id}: ${(err as Error).message}`
    );
  } finally {
    await resolved.cleanup();
  }
};

export const refreshTagsForFile = async (file: FileRecord) => {
  const sites = await loadTagSitesForFile(file);
  const runs = await filesRepo.listProviderRuns(file.id);
  const candidates = collectCandidatesFromRuns(runs, sites);
  await applyCombinedTags(file, candidates);
};
