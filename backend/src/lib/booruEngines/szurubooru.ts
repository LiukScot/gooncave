import { fetch } from 'undici';

import { config } from '../../config';
import type { BooruSiteRecord } from '../../db/types';

import {
  escapeRegex,
  extensionOf,
  normalizeTag,
  safeJoin,
  toIsoOrNull,
  toNumberOrNull,
  windowStartDate,
  WINDOW_SECONDS
} from './helpers';
import type { BooruEngineModule, RemotePost, TagResult } from './types';
import { todayIso, windowRange } from './windowRange';

// Szurubooru API reference: https://github.com/rr-/szurubooru/blob/master/doc/API.md
// Auth: `Authorization: Token base64(username:token)` where `token` is the
// API token rendered on the user's account page. There is no separate
// "favorites" endpoint exposed as a list — favorites are inferred via
// `query=fav:USERNAME` against /api/posts/. Tags returned per-post are an
// array of objects with `names: string[]` and `category: string`.

type SzurubooruTag = {
  names?: string[] | null;
  category?: string | null;
};

type SzurubooruPost = {
  id?: number | string | null;
  thumbnailUrl?: string | null;
  contentUrl?: string | null;
  canvasWidth?: number | null;
  canvasHeight?: number | null;
  safety?: string | null;
  score?: number | null;
  favoriteCount?: number | null;
  user?: { name?: string | null } | null;
  fileSize?: number | null;
  type?: string | null;
  creationTime?: string | null;
  tags?: SzurubooruTag[] | null;
  checksum?: string | null;
  checksumMD5?: string | null;
};

type SzurubooruSearchResponse = {
  query?: string;
  offset?: number;
  limit?: number;
  total?: number;
  results?: SzurubooruPost[] | null;
};

type SzurubooruPostResponse = SzurubooruPost;

const userAgent = () => config.e621.userAgent;

const buildHeaders = (site: BooruSiteRecord): Record<string, string> => {
  const headers: Record<string, string> = {
    'User-Agent': userAgent(),
    Accept: 'application/json'
  };
  if (site.username && site.apiKey) {
    const token = Buffer.from(`${site.username}:${site.apiKey}`).toString(
      'base64'
    );
    headers.Authorization = `Token ${token}`;
  }
  return headers;
};

const szurubooruRegex = (host: string) =>
  // Szurubooru post page is /post/{id} (no /show/). Some forks add a slug or
  // hash fragment after the id — capture just the numeric id.
  new RegExp(`^https?://(?:www\\.)?${escapeRegex(host)}/post/(\\d+)`, 'i');

const collectTagsFromPost = (
  post: SzurubooruPost | null | undefined
): TagResult[] => {
  if (!post?.tags || !Array.isArray(post.tags)) return [];
  const bucket: TagResult[] = [];
  for (const entry of post.tags) {
    const names = Array.isArray(entry?.names) ? entry.names : [];
    const category =
      typeof entry?.category === 'string' ? entry.category : 'general';
    for (const name of names) {
      const cleaned = normalizeTag(name);
      if (cleaned) bucket.push({ tag: cleaned, category });
    }
  }
  return bucket;
};

export const szurubooruEngine: BooruEngineModule = {
  type: 'szurubooru',
  credentialSchema: 'token',
  defaultCapabilities: {
    favorites: false,
    tags: true,
    sourceMatch: true,
    search: true,
    vote: true
  },
  defaultUserAgent: '',
  probePath: '/api/posts/?offset=0&limit=1',
  probeMatches: (body: unknown): boolean => {
    if (!body || typeof body !== 'object') return false;
    const results = (body as SzurubooruSearchResponse).results;
    if (!Array.isArray(results)) return false;
    if (results.length === 0) return true; // empty board is a valid szurubooru
    const first = results[0];
    if (!first || typeof first !== 'object') return false;
    const tags = (first as SzurubooruPost).tags;
    if (!Array.isArray(tags)) return false;
    const sample = tags[0];
    return (
      !!sample &&
      typeof sample === 'object' &&
      Array.isArray((sample as { names?: unknown }).names)
    );
  },
  probeSample: (body: unknown) => {
    const results = (body as SzurubooruSearchResponse | null)?.results;
    const post = Array.isArray(results) ? results[0] : null;
    if (!post?.id) return null;
    const id = String(post.id);
    return {
      postId: id,
      thumbUrl: post.thumbnailUrl ?? null,
      postPath: `/post/${id}`
    };
  },

  async searchPosts(site, options) {
    const tokens = [...options.tags];
    if (options.sort !== 'new') {
      // Same shape as the other engines without an age-weighted ranking:
      // best inside a window. szurubooru spells the floor `creation-time`.
      const period =
        options.sort === 'hot'
          ? { start: windowStartDate(WINDOW_SECONDS.day), end: todayIso() }
          : windowRange(options.window, options.date);
      tokens.push('sort:score', `creation-time:${period.start}..${period.end}`);
    }
    const params = new URLSearchParams({
      query: tokens.join(' '),
      offset: String((options.page - 1) * options.limit),
      limit: String(options.limit)
    });
    const headers = buildHeaders(site);
    const res = await fetch(
      safeJoin(site.baseUrl, `/api/posts/?${params.toString()}`),
      { headers }
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `${site.name} search failed (${res.status}): ${text.slice(0, 200)}`
      );
    }
    const data = JSON.parse(text) as SzurubooruSearchResponse;
    // szurubooru returns instance-relative content URLs
    const absUrl = (value: string | null | undefined): string | null =>
      value
        ? /^https?:/i.test(value)
          ? value
          : safeJoin(site.baseUrl, `/${value.replace(/^\/+/, '')}`)
        : null;
    const posts: RemotePost[] = [];
    for (const post of data.results ?? []) {
      if (post?.id === null || post?.id === undefined) continue;
      posts.push({
        remoteId: String(post.id),
        previewUrl: absUrl(post.thumbnailUrl),
        sampleUrl: absUrl(post.contentUrl),
        fileUrl: absUrl(post.contentUrl),
        width: toNumberOrNull(post.canvasWidth),
        height: toNumberOrNull(post.canvasHeight),
        score: toNumberOrNull(post.score),
        rating: post.safety ?? null,
        md5: post.checksumMD5 ?? null,
        createdAt: toIsoOrNull(post.creationTime),
        tags: collectTagsFromPost(post),
        favCount: toNumberOrNull(post.favoriteCount),
        uploader: post.user?.name ?? null,
        fileExt: extensionOf(absUrl(post.contentUrl)),
        fileSize: toNumberOrNull(post.fileSize),
        favorited: null,
        voted: null
      });
    }
    return { posts, downloadHeaders: headers };
  },

  async vote(site, postId, score) {
    if (!site.username || !site.apiKey)
      throw new Error(`${site.name} credentials missing`);
    const res = await fetch(
      safeJoin(site.baseUrl, `/api/post/${postId}/score`),
      {
        method: 'PUT',
        headers: { ...buildHeaders(site), 'Content-Type': 'application/json' },
        body: JSON.stringify({ score })
      }
    );
    if (res.ok) return;
    const text = await res.text();
    throw new Error(
      `${site.name} vote failed (${res.status}): ${text.slice(0, 200)}`
    );
  },

  async fetchPostTags(site, postId) {
    const res = await fetch(safeJoin(site.baseUrl, `/api/post/${postId}`), {
      headers: buildHeaders(site)
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn(
        `[tags] szurubooru fetch failed (${res.status}): ${text.slice(0, 200)}`
      );
      return [];
    }
    let data: SzurubooruPostResponse;
    try {
      data = JSON.parse(text) as SzurubooruPostResponse;
    } catch {
      console.warn(`[tags] szurubooru parse failed: ${text.slice(0, 200)}`);
      return [];
    }
    return collectTagsFromPost(data);
  },

  async fetchPostByMd5(site, md5) {
    // Szurubooru does not expose a generic md5 lookup. The closest match is
    // /api/posts/?query=md5:HASH but some forks reject it. Best-effort.
    const params = new URLSearchParams({
      query: `checksum:${md5}`,
      offset: '0',
      limit: '1'
    });
    const res = await fetch(
      safeJoin(site.baseUrl, `/api/posts/?${params.toString()}`),
      {
        headers: buildHeaders(site)
      }
    );
    const text = await res.text();
    if (!res.ok) {
      console.warn(
        `[tags] szurubooru md5 fetch failed (${res.status}): ${text.slice(0, 200)}`
      );
      return null;
    }
    let data: SzurubooruSearchResponse;
    try {
      data = JSON.parse(text) as SzurubooruSearchResponse;
    } catch {
      console.warn(`[tags] szurubooru md5 parse failed: ${text.slice(0, 200)}`);
      return null;
    }
    const post = Array.isArray(data.results) ? data.results[0] : null;
    if (!post) return null;
    const id = post.id ? String(post.id) : null;
    return {
      tags: collectTagsFromPost(post),
      sourceUrl: id ? safeJoin(site.baseUrl, `/post/${id}`) : null
    };
  },

  extractIdFromUrl(url, site) {
    const host = new URL(site.baseUrl).hostname
      .replace(/^www\./, '')
      .toLowerCase();
    const match = url.match(szurubooruRegex(host));
    if (!match?.[1]) return null;
    return { remoteId: match[1] };
  },

  buildPostUrl(site, postId) {
    return safeJoin(site.baseUrl, `/post/${postId}`);
  }
};
