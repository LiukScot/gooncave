import fs from 'fs';
import os from 'os';
import path from 'path';

import ffmpeg from 'fluent-ffmpeg';
import { FormData, fetch } from 'undici';

import { config } from '../config';
import { dataStore, FileRecord, ProviderRunRecord, TagSource } from '../lib/dataStore';
import { resolveCredential } from './credentials';

type TagCandidateSource = 'E621' | 'DANBOORU' | 'GELBOORU' | 'YANDERE' | 'KONACHAN' | 'SANKAKU' | 'IDOL_COMPLEX';

type TagCandidate = {
  source: TagCandidateSource;
  id: string;
  idKind?: 'POST' | 'MD5';
  url: string;
  score: number;
  baseUrl?: string;
};

type TagResult = {
  tag: string;
  category: string;
  score?: number | null;
  sourceUrl?: string | null;
};

const providerScoreThresholds: Record<ProviderRunRecord['provider'], number> = {
  SAUCENAO: 90,
  FLUFFLE: 95
};

const resolveFileUserId = async (fileId: string) => {
  const user = await dataStore.findUserByFileId(fileId);
  return user?.id;
};

const resolveE621Auth = async (userId?: string) => {
  const credential = await resolveCredential('E621', userId);
  if (!credential.username || !credential.apiKey) return null;
  return { username: credential.username, apiKey: credential.apiKey, userAgent: config.e621.userAgent };
};

const resolveDanbooruAuth = async (userId?: string) => {
  const credential = await resolveCredential('DANBOORU', userId);
  if (!credential.username || !credential.apiKey) return null;
  return { username: credential.username, apiKey: credential.apiKey, userAgent: config.e621.userAgent };
};

const e621Regex = /https?:\/\/(?:www\.)?e621\.net\/(?:posts|post\/show)\/(\d+)/i;
const danbooruRegex = /https?:\/\/(?:www\.)?danbooru\.donmai\.us\/(?:posts|post\/show)\/(\d+)/i;
const gelbooruRegex = /https?:\/\/(?:www\.)?gelbooru\.com\/index\.php/i;
const yandereRegex = /https?:\/\/(?:www\.)?yande\.re\/post\/show\/(\d+)/i;
const konachanRegex = /https?:\/\/(?:www\.)?konachan\.(?:com|net)\/post\/show\/(\d+)/i;
const sankakuRegex = /https?:\/\/(?:www\.)?chan\.sankakucomplex\.com\/post\/show\/(\d+)/i;
const idolComplexRegex = /https?:\/\/(?:www\.)?idol\.sankakucomplex\.com\/post\/show\/(\d+)/i;

const normalizeTag = (value: string) =>
  value
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w:()-]+/g, '')
    .toLowerCase();

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

const resolveNumericId = (value: string | null | undefined) => {
  if (!value) return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
};

const md5Regex = /\b[a-f0-9]{32}\b/i;

const resolveMd5 = (value: string | null | undefined) => {
  if (!value) return null;
  const match = value.match(md5Regex);
  return match ? match[0].toLowerCase() : null;
};

const resolveSourceFromName = (value: string): TagCandidateSource | null => {
  const lower = value.toLowerCase();
  if (lower.includes('danbooru')) return 'DANBOORU' as const;
  if (lower.includes('e621')) return 'E621' as const;
  return null;
};

const resolveIdFromUrl = (url: URL) => {
  const idParam = resolveNumericId(url.searchParams.get('id'));
  if (idParam) return idParam;
  const match = url.pathname.match(/\/(\d+)(?:\.\w+)?$/);
  return match ? match[1] : null;
};

const resolveSourceFromUrl = (url: URL): TagCandidateSource | null => {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host.endsWith('e621.net')) return 'E621' as const;
  if (host.endsWith('donmai.us')) return 'DANBOORU' as const;
  return null;
};

const resolveTagCandidate = (
  url: string | null | undefined,
  score: number,
  sourceName?: string | null
): TagCandidate | null => {
  if (url) {
    if (e621Regex.test(url)) {
      const match = url.match(e621Regex);
      const id = match?.[1];
      if (id) return { source: 'E621', id, idKind: 'POST', url, score };
    }
    if (danbooruRegex.test(url)) {
      const match = url.match(danbooruRegex);
      const id = match?.[1];
      if (id) return { source: 'DANBOORU', id, idKind: 'POST', url, score };
    }
    if (yandereRegex.test(url)) {
      const match = url.match(yandereRegex);
      const id = match?.[1];
      if (id) return { source: 'YANDERE', id, idKind: 'POST', url, score, baseUrl: 'https://yande.re' };
    }
    if (konachanRegex.test(url)) {
      const match = url.match(konachanRegex);
      const id = match?.[1];
      if (id) {
        const host = url.includes('konachan.net') ? 'https://konachan.net' : 'https://konachan.com';
        return { source: 'KONACHAN', id, idKind: 'POST', url, score, baseUrl: host };
      }
    }
    if (sankakuRegex.test(url)) {
      const match = url.match(sankakuRegex);
      const id = match?.[1];
      if (id) {
        return { source: 'SANKAKU', id, idKind: 'POST', url, score, baseUrl: 'https://chan.sankakucomplex.com' };
      }
    }
    if (idolComplexRegex.test(url)) {
      const match = url.match(idolComplexRegex);
      const id = match?.[1];
      if (id) {
        return { source: 'IDOL_COMPLEX', id, idKind: 'POST', url, score, baseUrl: 'https://idol.sankakucomplex.com' };
      }
    }
    if (gelbooruRegex.test(url)) {
      try {
        const parsed = new URL(url);
        const id = resolveIdFromUrl(parsed);
        if (id) return { source: 'GELBOORU', id, idKind: 'POST', url, score, baseUrl: 'https://gelbooru.com' };
      } catch {
        // ignore
      }
    }
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      const id = resolveIdFromUrl(parsed);
      if (id) {
        if (host === 'yande.re') return { source: 'YANDERE', id, idKind: 'POST', url, score, baseUrl: 'https://yande.re' };
        if (host === 'konachan.com' || host === 'konachan.net') {
          return { source: 'KONACHAN', id, idKind: 'POST', url, score, baseUrl: `https://${host}` };
        }
        if (host === 'gelbooru.com') {
          return { source: 'GELBOORU', id, idKind: 'POST', url, score, baseUrl: 'https://gelbooru.com' };
        }
        if (host === 'chan.sankakucomplex.com') {
          return { source: 'SANKAKU', id, idKind: 'POST', url, score, baseUrl: 'https://chan.sankakucomplex.com' };
        }
        if (host === 'idol.sankakucomplex.com') {
          return { source: 'IDOL_COMPLEX', id, idKind: 'POST', url, score, baseUrl: 'https://idol.sankakucomplex.com' };
        }
      }
      const md5 = resolveMd5(url) ?? resolveMd5(sourceName ?? null);
      const inferred = resolveSourceFromUrl(parsed) ?? (sourceName ? resolveSourceFromName(sourceName) : null);
      if (md5 && inferred) {
        return { source: inferred, id: md5, idKind: 'MD5', url, score };
      }
    } catch {
      // ignore
    }
  }
  const md5 = resolveMd5(url ?? null) ?? resolveMd5(sourceName ?? null);
  const inferred = sourceName ? resolveSourceFromName(sourceName) : null;
  if (md5 && inferred) {
    return { source: inferred, id: md5, idKind: 'MD5', url: url ?? '', score };
  }
  return null;
};

const buildE621Tags = (tags: any) => {
  if (!tags) return [];
  const bucket: TagResult[] = [];
  const pushTags = (category: string, values: string[]) => {
    for (const tag of values ?? []) {
      const cleaned = normalizeTag(tag);
      if (cleaned) bucket.push({ tag: cleaned, category });
    }
  };
  pushTags('general', tags.general ?? []);
  pushTags('artist', tags.artist ?? []);
  pushTags('character', tags.character ?? []);
  pushTags('species', tags.species ?? []);
  pushTags('meta', tags.meta ?? []);
  pushTags('lore', tags.lore ?? []);
  pushTags('invalid', tags.invalid ?? []);
  return bucket;
};

const buildDanbooruTags = (data: any) => {
  const bucket: TagResult[] = [];
  const pushTags = (category: string, value?: string) => {
    if (!value) return;
    value
      .split(' ')
      .map((tag) => normalizeTag(tag))
      .filter(Boolean)
      .forEach((tag) => bucket.push({ tag, category }));
  };
  pushTags('general', data?.tag_string_general);
  pushTags('artist', data?.tag_string_artist);
  pushTags('character', data?.tag_string_character);
  pushTags('copyright', data?.tag_string_copyright);
  pushTags('meta', data?.tag_string_meta);
  return bucket;
};

const extractCandidates = (run: ProviderRunRecord): TagCandidate[] => {
  const minScore = providerScoreThresholds[run.provider] ?? 0;
  const results =
    run.results && run.results.length
      ? run.results
      : run.sourceUrl
        ? [{ sourceUrl: run.sourceUrl, score: run.score }]
        : [];
  const picks = new Map<TagCandidateSource, TagCandidate>();

  for (const result of results) {
    const score = resolveCandidateScore(run, result);
    if (score < minScore) continue;
    const url = result.sourceUrl ?? null;
    const sourceName = (result as { sourceName?: string | null }).sourceName ?? null;
    const candidate = resolveTagCandidate(url, score, sourceName);
    if (!candidate) continue;
    const existing = picks.get(candidate.source);
    if (!existing || score > existing.score) {
      picks.set(candidate.source, candidate);
    }
  }

  return Array.from(picks.values());
};

const collectCandidatesFromRuns = (runs: ProviderRunRecord[]) => {
  const picks = new Map<TagCandidateSource, TagCandidate>();
  for (const run of runs) {
    if (run.status !== 'COMPLETED') continue;
    const candidates = extractCandidates(run);
    for (const candidate of candidates) {
      const existing = picks.get(candidate.source);
      if (!existing || candidate.score > existing.score) {
        picks.set(candidate.source, candidate);
      }
    }
  }
  return Array.from(picks.values());
};

const fetchE621Tags = async (postId: string, userId?: string) => {
  const auth = await resolveE621Auth(userId);
  if (!auth) return [];
  const token = Buffer.from(`${auth.username}:${auth.apiKey}`).toString('base64');
  const res = await fetch(`https://e621.net/posts/${postId}.json`, {
    headers: {
      Authorization: `Basic ${token}`,
      'User-Agent': auth.userAgent
    }
  });
  const text = await res.text();
  if (!res.ok) {
    console.warn(`[tags] e621 fetch failed (${res.status}): ${text.slice(0, 200)}`);
    return [];
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn(`[tags] e621 parse failed: ${text.slice(0, 200)}`);
    return [];
  }
  const tags = data?.post?.tags;
  return buildE621Tags(tags);
};

const fetchE621TagsByMd5 = async (md5: string, userId?: string) => {
  const auth = await resolveE621Auth(userId);
  if (!auth) return { tags: [], sourceUrl: null };
  const token = Buffer.from(`${auth.username}:${auth.apiKey}`).toString('base64');
  const res = await fetch(`https://e621.net/posts.json?md5=${md5}`, {
    headers: {
      Authorization: `Basic ${token}`,
      'User-Agent': auth.userAgent
    }
  });
  const text = await res.text();
  if (!res.ok) {
    console.warn(`[tags] e621 md5 fetch failed (${res.status}): ${text.slice(0, 200)}`);
    return { tags: [], sourceUrl: null };
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn(`[tags] e621 md5 parse failed: ${text.slice(0, 200)}`);
    return { tags: [], sourceUrl: null };
  }
  const post = data?.post ?? (Array.isArray(data?.posts) ? data.posts[0] : null);
  const tags = buildE621Tags(post?.tags ?? null);
  const postId = post?.id ? String(post.id) : null;
  return { tags, sourceUrl: postId ? `https://e621.net/posts/${postId}` : null };
};

const fetchDanbooruTags = async (postId: string, userId?: string) => {
  const auth = await resolveDanbooruAuth(userId);
  if (!auth) return [];
  const token = Buffer.from(`${auth.username}:${auth.apiKey}`).toString('base64');
  const res = await fetch(`https://danbooru.donmai.us/posts/${postId}.json`, {
    headers: {
      Authorization: `Basic ${token}`,
      'User-Agent': auth.userAgent
    }
  });
  const text = await res.text();
  if (!res.ok) {
    console.warn(`[tags] danbooru fetch failed (${res.status}): ${text.slice(0, 200)}`);
    return [];
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn(`[tags] danbooru parse failed: ${text.slice(0, 200)}`);
    return [];
  }
  return buildDanbooruTags(data);
};

const fetchDanbooruTagsByMd5 = async (md5: string, userId?: string) => {
  const auth = await resolveDanbooruAuth(userId);
  if (!auth) return { tags: [], sourceUrl: null };
  const token = Buffer.from(`${auth.username}:${auth.apiKey}`).toString('base64');
  const res = await fetch(`https://danbooru.donmai.us/posts.json?md5=${md5}`, {
    headers: {
      Authorization: `Basic ${token}`,
      'User-Agent': auth.userAgent
    }
  });
  const text = await res.text();
  if (!res.ok) {
    console.warn(`[tags] danbooru md5 fetch failed (${res.status}): ${text.slice(0, 200)}`);
    return { tags: [], sourceUrl: null };
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn(`[tags] danbooru md5 parse failed: ${text.slice(0, 200)}`);
    return { tags: [], sourceUrl: null };
  }
  const post = Array.isArray(data) ? data[0] : data?.post ?? (Array.isArray(data?.posts) ? data.posts[0] : null);
  if (!post) return { tags: [], sourceUrl: null };
  const tags = buildDanbooruTags(post);
  const postId = post?.id ? String(post.id) : null;
  return { tags, sourceUrl: postId ? `https://danbooru.donmai.us/posts/${postId}` : null };
};

const fetchGelbooruTags = async (postId: string) => {
  const params = new URLSearchParams({
    page: 'dapi',
    s: 'post',
    q: 'index',
    id: postId,
    json: '1'
  });
  if (config.gelbooru.userId && config.gelbooru.apiKey) {
    params.set('user_id', config.gelbooru.userId);
    params.set('api_key', config.gelbooru.apiKey);
  }
  const res = await fetch(`https://gelbooru.com/index.php?${params.toString()}`, {
    headers: {
      'User-Agent': config.e621.userAgent
    }
  });
  const text = await res.text();
  if (!res.ok) {
    console.warn(`[tags] gelbooru fetch failed (${res.status}): ${text.slice(0, 200)}`);
    return [];
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn(`[tags] gelbooru parse failed: ${text.slice(0, 200)}`);
    return [];
  }
  const entry = Array.isArray(data) ? data[0] : data?.post ?? data;
  const rawTags = typeof entry?.tags === 'string' ? entry.tags : '';
  if (!rawTags) return [];
  return rawTags
    .split(' ')
    .map((tag: string) => normalizeTag(tag))
    .filter(Boolean)
    .map((tag: string) => ({ tag, category: 'general' }));
};

const fetchMoebooruTags = async (baseUrl: string, postId: string) => {
  const endpoints = [`${baseUrl}/post/show/${postId}.json`, `${baseUrl}/post.json?tags=id:${postId}`];
  for (const endpoint of endpoints) {
    const res = await fetch(endpoint, {
      headers: {
        'User-Agent': config.e621.userAgent
      }
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`[tags] moebooru fetch failed (${res.status}): ${text.slice(0, 200)}`);
      continue;
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      console.warn(`[tags] moebooru parse failed: ${text.slice(0, 200)}`);
      continue;
    }
    const entry = Array.isArray(data) ? data[0] : data;
    if (!entry) continue;
    const bucket: TagResult[] = [];
    const pushTags = (category: string, value?: string) => {
      if (!value) return;
      value
        .split(' ')
        .map((tag) => normalizeTag(tag))
        .filter(Boolean)
        .forEach((tag) => bucket.push({ tag, category }));
    };
    pushTags('general', entry.tags_general ?? entry.tags ?? '');
    pushTags('artist', entry.tags_artist ?? '');
    pushTags('character', entry.tags_character ?? '');
    pushTags('copyright', entry.tags_copyright ?? '');
    pushTags('meta', entry.tags_meta ?? '');
    if (bucket.length) return bucket;
    return [];
  }
  return [];
};

const fetchSankakuTags = async (postId: string, baseUrl: string) => {
  const endpoints = [
    `https://capi-v2.sankakucomplex.com/posts/${postId}`,
    `${baseUrl}/post/show/${postId}.json`
  ];
  for (const endpoint of endpoints) {
    const res = await fetch(endpoint, {
      headers: {
        'User-Agent': config.e621.userAgent,
        Accept: 'application/json'
      }
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`[tags] sankaku fetch failed (${res.status}): ${text.slice(0, 200)}`);
      continue;
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      console.warn(`[tags] sankaku parse failed: ${text.slice(0, 200)}`);
      continue;
    }
    const entry = Array.isArray(data) ? data[0] : data;
    if (!entry) continue;
    const bucket: TagResult[] = [];
    if (Array.isArray(entry.tags)) {
      for (const item of entry.tags) {
        const name = typeof item?.name === 'string' ? normalizeTag(item.name) : '';
        if (!name) continue;
        const rawType = item?.type;
        let category = 'general';
        if (typeof rawType === 'string') {
          category = rawType.toLowerCase();
        } else if (typeof rawType === 'number') {
          switch (rawType) {
            case 1:
              category = 'artist';
              break;
            case 3:
              category = 'copyright';
              break;
            case 4:
              category = 'character';
              break;
            case 5:
              category = 'meta';
              break;
            default:
              category = 'general';
          }
        }
        bucket.push({ tag: name, category });
      }
    } else if (typeof entry.tags === 'string') {
      entry.tags
        .split(' ')
        .map((tag: string) => normalizeTag(tag))
        .filter(Boolean)
        .forEach((tag: string) => bucket.push({ tag, category: 'general' }));
    }
    if (bucket.length) return bucket;
    return [];
  }
  return [];
};

const resolveLocalPath = async (file: FileRecord) => {
  return { path: file.path, cleanup: async () => undefined };
};

const runWd14Tagger = async (imagePath: string) => {
  const form = new FormData();
  form.set('file', await fs.openAsBlob(imagePath), path.basename(imagePath));
  const res = await fetch(`${config.tagger.url}/tag`, {
    method: 'POST',
    body: form
  });
  if (!res.ok) {
    throw new Error(`tagger error: ${res.status}`);
  }
  const data = (await res.json()) as any;
  return (data?.tags ?? []) as { tag: string; score: number; category: string }[];
};

const extractVideoFrames = async (filePath: string, count: number) => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'imagesearch-frames-'));
  const durationSeconds = await new Promise<number>((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        resolve(0);
        return;
      }
      resolve(data.format.duration ?? 0);
    });
  });
  const stamps =
    durationSeconds > 0
      ? Array.from({ length: count }, (_, idx) => ((durationSeconds * (idx + 1)) / (count + 1)).toFixed(2))
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

const mergeTagScores = (sets: { tag: string; score: number; category: string }[][]) => {
  const map = new Map<string, { tag: string; score: number; category: string }>();
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
    const existingScore = typeof existing.score === 'number' ? existing.score : -Infinity;
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

const replaceTags = async (fileId: string, source: TagSource, tags: TagResult[], sourceUrl?: string) => {
  const uniqueTags = dedupeTags(tags);
  await dataStore.replaceTagsForSource(
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

export const applyRemotePostTags = async (
  file: FileRecord,
  provider: 'E621' | 'DANBOORU',
  postId: string,
  sourceUrl?: string | null
) => {
  const userId = await resolveFileUserId(file.id);
  if (provider === 'E621') {
    const tags = await fetchE621Tags(postId, userId);
    if (!tags.length) return { applied: false, count: 0 };
    await replaceTags(file.id, 'E621', tags, sourceUrl ?? `https://e621.net/posts/${postId}`);
    return { applied: true, count: tags.length };
  }
  const tags = await fetchDanbooruTags(postId, userId);
  if (!tags.length) return { applied: false, count: 0 };
  await replaceTags(file.id, 'DANBOORU', tags, sourceUrl ?? `https://danbooru.donmai.us/posts/${postId}`);
  return { applied: true, count: tags.length };
};

const applyCandidateTags = async (fileId: string, candidate: TagCandidate) => {
  const userId = await resolveFileUserId(fileId);
  if (candidate.source === 'E621') {
    if (candidate.idKind === 'MD5') {
      const result = await fetchE621TagsByMd5(candidate.id, userId);
      if (result.tags.length === 0) return false;
      await replaceTags(fileId, 'E621', result.tags, result.sourceUrl ?? candidate.url);
      return true;
    }
    const tags = await fetchE621Tags(candidate.id, userId);
    if (tags.length === 0) return false;
    await replaceTags(fileId, 'E621', tags, candidate.url);
    return true;
  }
  if (candidate.source === 'DANBOORU') {
    if (candidate.idKind === 'MD5') {
      const result = await fetchDanbooruTagsByMd5(candidate.id, userId);
      if (result.tags.length === 0) return false;
      await replaceTags(fileId, 'DANBOORU', result.tags, result.sourceUrl ?? candidate.url);
      return true;
    }
    const tags = await fetchDanbooruTags(candidate.id, userId);
    if (tags.length === 0) return false;
    await replaceTags(fileId, 'DANBOORU', tags, candidate.url);
    return true;
  }
  if (candidate.source === 'GELBOORU') {
    const tags = await fetchGelbooruTags(candidate.id);
    if (tags.length === 0) return false;
    await replaceTags(fileId, 'GELBOORU', tags, candidate.url);
    return true;
  }
  if (candidate.source === 'YANDERE') {
    const baseUrl = candidate.baseUrl ?? 'https://yande.re';
    const tags = await fetchMoebooruTags(baseUrl, candidate.id);
    if (tags.length === 0) return false;
    await replaceTags(fileId, 'YANDERE', tags, candidate.url);
    return true;
  }
  if (candidate.source === 'KONACHAN') {
    const baseUrl = candidate.baseUrl ?? 'https://konachan.com';
    const tags = await fetchMoebooruTags(baseUrl, candidate.id);
    if (tags.length === 0) return false;
    await replaceTags(fileId, 'KONACHAN', tags, candidate.url);
    return true;
  }
  if (candidate.source === 'SANKAKU') {
    const baseUrl = candidate.baseUrl ?? 'https://chan.sankakucomplex.com';
    const tags = await fetchSankakuTags(candidate.id, baseUrl);
    if (tags.length === 0) return false;
    await replaceTags(fileId, 'SANKAKU', tags, candidate.url);
    return true;
  }
  if (candidate.source === 'IDOL_COMPLEX') {
    const baseUrl = candidate.baseUrl ?? 'https://idol.sankakucomplex.com';
    const tags = await fetchSankakuTags(candidate.id, baseUrl);
    if (tags.length === 0) return false;
    await replaceTags(fileId, 'IDOL_COMPLEX', tags, candidate.url);
    return true;
  }
  return false;
};

const applyCombinedTags = async (file: FileRecord, candidates: TagCandidate[]) => {
  for (const candidate of candidates) {
    await applyCandidateTags(file.id, candidate);
  }
  await ensureWd14Tags(file, file.mediaType === 'VIDEO', { force: true });
};

export const refreshTagsFromProviderRun = async (file: FileRecord, _run: ProviderRunRecord) => {
  try {
    const runs = await dataStore.listProviderRuns(file.id);
    const candidates = collectCandidatesFromRuns(runs);
    await applyCombinedTags(file, candidates);
  } catch (err) {
    console.warn(`[tags] refresh failed for ${file.id}: ${(err as Error).message}`);
  }
};

export const ensureWd14Tags = async (
  file: FileRecord,
  forceForVideo: boolean,
  options?: { force?: boolean; ignoreSourceTags?: boolean }
) => {
  if (!config.tagger.url) return;
  const tags = await dataStore.listTagsForFile(file.id);
  const hasSourceTags = tags.some((tag) =>
    ['E621', 'DANBOORU', 'GELBOORU', 'YANDERE', 'KONACHAN', 'SANKAKU', 'IDOL_COMPLEX'].includes(tag.source)
  );
  const hasWd14 = tags.some((tag) => tag.source === 'WD14');
  if (hasWd14 && !options?.force) return;
  if (!forceForVideo && hasSourceTags && !options?.force && !options?.ignoreSourceTags) return;

  const resolved = await resolveLocalPath(file);
  if (!resolved) return;
  try {
    if (file.mediaType === 'VIDEO') {
      const { frames, cleanup } = await extractVideoFrames(resolved.path, 3);
      try {
        const results = await Promise.all(frames.map((frame) => runWd14Tagger(frame)));
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
    console.warn(`[tags] wd14 failed for ${file.id}: ${(err as Error).message}`);
  } finally {
    await resolved.cleanup();
  }
};

export const refreshTagsForFile = async (file: FileRecord) => {
  const runs = await dataStore.listProviderRuns(file.id);
  const candidates = collectCandidatesFromRuns(runs);
  await applyCombinedTags(file, candidates);
};
