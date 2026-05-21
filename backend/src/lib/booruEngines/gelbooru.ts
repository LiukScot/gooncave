import { fetch } from 'undici';

import { config } from '../../config';
import type { BooruSiteRecord } from '../dataStore';

import { normalizeTag, safeJoin } from './helpers';
import type { BooruEngineModule, TagResult } from './types';

type GelbooruPost = {
  id?: number | string | null;
  file_url?: string | null;
  preview_url?: string | null;
  sample_url?: string | null;
  width?: number | null;
  height?: number | null;
  rating?: string | null;
  tags?: string | null;
};

type GelbooruEnvelope = {
  post?: GelbooruPost | GelbooruPost[] | null;
};

type GelbooruResponse = GelbooruPost[] | GelbooruEnvelope | GelbooruPost;

const userAgent = () => config.e621.userAgent;

const buildHeaders = (): Record<string, string> => ({ 'User-Agent': userAgent() });

const buildBaseQuery = (site: BooruSiteRecord, extra: Record<string, string>): URLSearchParams => {
  const params = new URLSearchParams({
    page: 'dapi',
    s: 'post',
    q: 'index',
    json: '1',
    ...extra
  });
  // gelbooru uses user_id (numeric) + api_key
  if (site.username && site.apiKey) {
    params.set('user_id', site.username);
    params.set('api_key', site.apiKey);
  }
  return params;
};

const isEnvelope = (value: GelbooruResponse): value is GelbooruEnvelope =>
  !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'post');

const extractPosts = (data: GelbooruResponse): GelbooruPost[] => {
  if (Array.isArray(data)) return data;
  if (isEnvelope(data)) {
    if (Array.isArray(data.post)) return data.post;
    if (data.post) return [data.post];
    return [];
  }
  return [data];
};

export const gelbooruEngine: BooruEngineModule = {
  type: 'gelbooru',
  credentialSchema: 'userid+apikey',
  defaultCapabilities: { favorites: false, tags: true, sourceMatch: true, search: true },
  defaultUserAgent: '',
  probePath: '/index.php?page=dapi&s=post&q=index&json=1&limit=1',
  probeMatches: (body: unknown): boolean => {
    let posts: unknown;
    if (Array.isArray(body)) {
      posts = body;
    } else if (body && typeof body === 'object') {
      const env = body as GelbooruEnvelope;
      if (Array.isArray(env.post)) posts = env.post;
      else if (env.post) posts = [env.post];
    }
    if (!Array.isArray(posts) || posts.length === 0) return false;
    const first = posts[0];
    if (!first || typeof first !== 'object') return false;
    const p = first as GelbooruPost;
    return typeof p.tags === 'string' && (typeof p.file_url === 'string' || typeof p.sample_url === 'string');
  },
  probeSample: (body: unknown) => {
    const posts = extractPosts(body as GelbooruResponse);
    const post = posts[0];
    if (!post?.id) return null;
    const id = String(post.id);
    return {
      postId: id,
      thumbUrl: post.preview_url ?? null,
      // Gelbooru uses query string, not path — keep absolute-style postPath
      // with leading ?param to make safeJoin() produce a usable URL.
      postPath: `/index.php?page=post&s=view&id=${id}`
    };
  },

  async fetchPostTags(site, postId): Promise<TagResult[]> {
    const params = buildBaseQuery(site, { id: postId, limit: '1' });
    const res = await fetch(safeJoin(site.baseUrl, `/index.php?${params.toString()}`), {
      headers: buildHeaders()
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`[tags] gelbooru fetch failed (${res.status}): ${text.slice(0, 200)}`);
      return [];
    }
    let data: GelbooruResponse;
    try {
      data = JSON.parse(text) as GelbooruResponse;
    } catch {
      console.warn(`[tags] gelbooru parse failed: ${text.slice(0, 200)}`);
      return [];
    }
    const posts = extractPosts(data);
    const entry = posts[0];
    const rawTags = typeof entry?.tags === 'string' ? entry.tags : '';
    if (!rawTags) return [];
    return rawTags
      .split(' ')
      .map((tag) => normalizeTag(tag))
      .filter(Boolean)
      .map((tag) => ({ tag, category: 'general' }));
  },

  extractIdFromUrl(url, site) {
    try {
      const parsed = new URL(url);
      const siteHost = new URL(site.baseUrl).hostname.replace(/^www\./, '').toLowerCase();
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      if (host !== siteHost) return null;
      const idParam = parsed.searchParams.get('id');
      if (!idParam || !/^\d+$/.test(idParam)) return null;
      return { remoteId: idParam };
    } catch {
      return null;
    }
  },

  buildPostUrl(site, postId) {
    return `${site.baseUrl.replace(/\/+$/, '')}/index.php?page=post&s=view&id=${postId}`;
  }
};
