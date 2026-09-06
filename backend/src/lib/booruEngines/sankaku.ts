import { fetch } from 'undici';

import { config } from '../../config';

import {
  escapeRegex,
  extensionOf,
  normalizeTag,
  safeJoin,
  toBoolean,
  toIsoOrNull,
  toNumberOrNull,
  toParentId
} from './helpers';
import type { BooruEngineModule, RemotePost, TagResult } from './types';
import { dateMetatag, windowRange } from './windowRange';

type SankakuTagEntry = {
  name?: string;
  type?: string | number;
};

type SankakuPost = {
  id?: number | string | null;
  file_url?: string | null;
  preview_url?: string | null;
  sample_url?: string | null;
  width?: number | null;
  height?: number | null;
  rating?: string | null;
  parent_id?: number | string | null;
  has_children?: boolean | null;
  md5?: string | null;
  total_score?: number | null;
  fav_count?: number | null;
  author?: { name?: string | null } | null;
  file_size?: number | null;
  created_at?: { s?: number | null } | string | null;
  tags?: SankakuTagEntry[] | string;
};

type SankakuResponse = SankakuPost[] | SankakuPost;

const userAgent = () => config.e621.userAgent;

const buildHeaders = (): Record<string, string> => ({
  'User-Agent': userAgent(),
  Accept: 'application/json'
});

const sankakuRegex = (host: string) =>
  new RegExp(`^https?://(?:www\\.)?${escapeRegex(host)}/post/show/(\\d+)`, 'i');

const categoryForType = (rawType: unknown): string => {
  if (typeof rawType === 'string') return rawType.toLowerCase();
  if (typeof rawType === 'number') {
    switch (rawType) {
      case 1:
        return 'artist';
      case 3:
        return 'copyright';
      case 4:
        return 'character';
      case 5:
        return 'meta';
      default:
        return 'general';
    }
  }
  return 'general';
};

const extractTags = (entry: SankakuPost): TagResult[] => {
  const bucket: TagResult[] = [];
  if (Array.isArray(entry.tags)) {
    for (const item of entry.tags) {
      const name =
        typeof item?.name === 'string' ? normalizeTag(item.name) : '';
      if (!name) continue;
      bucket.push({ tag: name, category: categoryForType(item?.type) });
    }
  } else if (typeof entry.tags === 'string') {
    entry.tags
      .split(' ')
      .map((tag) => normalizeTag(tag))
      .filter(Boolean)
      .forEach((tag) => bucket.push({ tag, category: 'general' }));
  }
  return bucket;
};

export const sankakuEngine: BooruEngineModule = {
  type: 'sankaku',
  credentialSchema: 'token',
  defaultCapabilities: {
    favorites: false,
    tags: true,
    sourceMatch: true,
    search: true,
    vote: false
  },
  supportsRelations: true,
  defaultUserAgent: '',
  probePath: '/posts?limit=1',
  probeMatches: (body: unknown): boolean => {
    if (!Array.isArray(body) || body.length === 0) return false;
    const first = body[0];
    if (!first || typeof first !== 'object') return false;
    const tags = (first as SankakuPost).tags;
    if (!Array.isArray(tags)) return false;
    const sample = tags[0];
    return (
      !!sample &&
      typeof sample === 'object' &&
      typeof (sample as { name?: unknown }).name === 'string'
    );
  },
  probeSample: (body: unknown) => {
    const post = Array.isArray(body)
      ? (body[0] as SankakuPost | undefined)
      : null;
    if (!post?.id) return null;
    const id = String(post.id);
    return {
      postId: id,
      thumbUrl: post.preview_url ?? null,
      postPath: `/post/show/${id}`
    };
  },

  async searchPosts(site, options) {
    const tags = [...options.tags];
    // best-effort: sankaku's order:popular metatag; date floor for popular
    if (options.sort === 'hot') tags.push('order:popular');
    if (options.sort === 'popular') {
      const period = windowRange(options.window, options.date);
      tags.push('order:popular', dateMetatag(period));
    }
    const params = new URLSearchParams({
      tags: tags.join(' '),
      limit: String(options.limit),
      page: String(options.page)
    });
    const headers = buildHeaders();
    const res = await fetch(
      safeJoin(site.baseUrl, `/posts?${params.toString()}`),
      { headers }
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `${site.name} search failed (${res.status}): ${text.slice(0, 200)}`
      );
    }
    const data = JSON.parse(text) as SankakuResponse;
    const entries = Array.isArray(data) ? data : [data];
    const posts: RemotePost[] = [];
    for (const post of entries) {
      if (!post?.id) continue;
      const createdRaw =
        typeof post.created_at === 'object' && post.created_at
          ? (post.created_at.s ?? null)
          : (post.created_at ?? null);
      posts.push({
        remoteId: String(post.id),
        previewUrl: post.preview_url ?? null,
        sampleUrl: post.sample_url ?? null,
        fileUrl: post.file_url ?? post.sample_url ?? null,
        width: toNumberOrNull(post.width),
        height: toNumberOrNull(post.height),
        score: toNumberOrNull(post.total_score),
        rating: post.rating ?? null,
        md5: post.md5 ?? null,
        createdAt: toIsoOrNull(createdRaw),
        tags: extractTags(post),
        favCount: toNumberOrNull(post.fav_count),
        uploader: post.author?.name ?? null,
        fileExt: extensionOf(post.file_url ?? null),
        fileSize: toNumberOrNull(post.file_size),
        favorited: null,
        voted: null,
        parentId: toParentId(post.parent_id),
        hasChildren: toBoolean(post.has_children),
        // Not in a search result on this engine; read per post when asked.
        poolIds: null
      });
    }
    return { posts, downloadHeaders: headers };
  },

  async fetchPostTags(site, postId): Promise<TagResult[]> {
    // sankaku exposes its JSON API on a dedicated capi-v2 host. Fall back to
    // the legacy /post/show/{id}.json on the site itself if the api host
    // refuses (some self-hosted forks do not run capi-v2).
    const endpoints = [
      `https://capi-v2.sankakucomplex.com/posts/${postId}`,
      safeJoin(site.baseUrl, `/post/show/${postId}.json`)
    ];
    for (const endpoint of endpoints) {
      const res = await fetch(endpoint, { headers: buildHeaders() });
      const text = await res.text();
      if (!res.ok) {
        console.warn(
          `[tags] sankaku fetch failed (${res.status}): ${text.slice(0, 200)}`
        );
        continue;
      }
      let data: SankakuResponse;
      try {
        data = JSON.parse(text) as SankakuResponse;
      } catch {
        console.warn(`[tags] sankaku parse failed: ${text.slice(0, 200)}`);
        continue;
      }
      const entry = Array.isArray(data) ? data[0] : data;
      if (!entry) continue;
      const tags = extractTags(entry);
      if (tags.length) return tags;
    }
    return [];
  },

  extractIdFromUrl(url, site) {
    const host = new URL(site.baseUrl).hostname
      .replace(/^www\./, '')
      .toLowerCase();
    const match = url.match(sankakuRegex(host));
    if (!match?.[1]) return null;
    return { remoteId: match[1] };
  },

  buildPostUrl(site, postId) {
    return safeJoin(site.baseUrl, `/post/show/${postId}`);
  }
};
