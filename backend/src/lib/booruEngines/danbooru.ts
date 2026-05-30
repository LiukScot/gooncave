import { fetch } from 'undici';

import { config } from '../../config';
import type { BooruSiteRecord } from '../../db/types';

import { basicAuthHeader, normalizeTag, safeJoin } from './helpers';
import type { BooruEngineModule, BooruRemoteFavorite, TagResult } from './types';

type DanbooruPost = {
  id?: number | string | null;
  file_url?: string | null;
  large_file_url?: string | null;
  preview_file_url?: string | null;
  image_width?: number | null;
  image_height?: number | null;
  rating?: string | null;
  tag_string?: string | null;
  tag_string_general?: string;
  tag_string_artist?: string;
  tag_string_character?: string;
  tag_string_copyright?: string;
  tag_string_meta?: string;
};

type DanbooruResponse =
  | DanbooruPost[]
  | { post?: DanbooruPost | null; posts?: DanbooruPost[] | null };

const userAgent = () => config.e621.userAgent;

const escapeRegex = (value: string): string => value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

const buildDanbooruTags = (data: DanbooruPost | null | undefined): TagResult[] => {
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

const buildHeaders = (site: BooruSiteRecord): Record<string, string> => {
  const headers: Record<string, string> = { 'User-Agent': userAgent() };
  if (site.username && site.apiKey) {
    headers.Authorization = basicAuthHeader(site.username, site.apiKey);
  }
  return headers;
};

const danbooruRegex = (host: string) =>
  new RegExp(`^https?://(?:www\\.)?${escapeRegex(host)}/(?:posts|post/show)/(\\d+)`, 'i');

export const danbooruEngine: BooruEngineModule = {
  type: 'danbooru',
  credentialSchema: 'username+apikey',
  defaultCapabilities: { favorites: true, tags: true, sourceMatch: true, search: true },
  defaultUserAgent: '',
  probePath: '/posts.json?limit=1',
  probeMatches: (body: unknown): boolean => {
    if (!Array.isArray(body) || body.length === 0) return false;
    const first = body[0];
    if (!first || typeof first !== 'object') return false;
    return typeof (first as DanbooruPost).tag_string_general === 'string';
  },
  probeSample: (body: unknown) => {
    const post = Array.isArray(body) ? (body[0] as DanbooruPost | undefined) : null;
    if (!post?.id) return null;
    const id = String(post.id);
    return {
      postId: id,
      thumbUrl: post.preview_file_url ?? null,
      postPath: `/posts/${id}`
    };
  },

  async fetchPostTags(site, postId): Promise<TagResult[]> {
    if (!site.username || !site.apiKey) return [];
    const res = await fetch(safeJoin(site.baseUrl, `/posts/${postId}.json`), { headers: buildHeaders(site) });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`[tags] danbooru fetch failed (${res.status}): ${text.slice(0, 200)}`);
      return [];
    }
    let data: DanbooruPost;
    try {
      data = JSON.parse(text) as DanbooruPost;
    } catch {
      console.warn(`[tags] danbooru parse failed: ${text.slice(0, 200)}`);
      return [];
    }
    return buildDanbooruTags(data);
  },

  async fetchPostByMd5(site, md5) {
    if (!site.username || !site.apiKey) return null;
    const res = await fetch(safeJoin(site.baseUrl, `/posts.json?md5=${md5}`), { headers: buildHeaders(site) });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`[tags] danbooru md5 fetch failed (${res.status}): ${text.slice(0, 200)}`);
      return null;
    }
    let data: DanbooruResponse;
    try {
      data = JSON.parse(text) as DanbooruResponse;
    } catch {
      console.warn(`[tags] danbooru md5 parse failed: ${text.slice(0, 200)}`);
      return null;
    }
    const post = Array.isArray(data)
      ? data[0]
      : data?.post ?? (Array.isArray(data?.posts) ? data!.posts![0] : null);
    if (!post) return null;
    const tags = buildDanbooruTags(post);
    const postId = post.id ? String(post.id) : null;
    return { tags, sourceUrl: postId ? safeJoin(site.baseUrl, `/posts/${postId}`) : null };
  },

  async fetchFavorites(site, ctx) {
    if (!site.username || !site.apiKey) {
      throw new Error(`${site.name} credentials missing`);
    }
    const headers = buildHeaders(site);
    const items: BooruRemoteFavorite[] = [];
    const limit = 200;
    let page = 1;
    for (;;) {
      const params = new URLSearchParams({
        tags: `fav:${site.username}`,
        limit: String(limit),
        page: String(page)
      });
      const res = await fetch(safeJoin(site.baseUrl, `/posts.json?${params.toString()}`), { headers });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${site.name} favorites failed (${res.status}): ${text.slice(0, 200)}`);
      }
      let data: DanbooruResponse;
      try {
        data = JSON.parse(text) as DanbooruResponse;
      } catch {
        throw new Error(`${site.name} favorites parse failed: ${text.slice(0, 200)}`);
      }
      const posts = Array.isArray(data) ? data : Array.isArray(data.posts) ? data.posts : [];
      if (!posts.length) break;
      ctx?.onPage?.(page, posts.length);
      for (const post of posts) {
        const id = post?.id ? String(post.id) : null;
        const fileUrl = post?.file_url ?? post?.large_file_url ?? null;
        if (!id) continue;
        items.push({
          provider: site.id,
          remoteId: id,
          sourceUrl: safeJoin(site.baseUrl, `/posts/${id}`),
          fileUrl
        });
      }
      if (posts.length < limit) break;
      page += 1;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { items, downloadHeaders: headers };
  },

  async favorite(site, postId) {
    if (!site.username || !site.apiKey) throw new Error(`${site.name} credentials missing`);
    const body = new URLSearchParams({ post_id: postId });
    const res = await fetch(safeJoin(site.baseUrl, '/favorites.json'), {
      method: 'POST',
      headers: {
        ...buildHeaders(site),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
    if (res.ok || res.status === 422) return;
    const text = await res.text();
    throw new Error(`${site.name} favorite failed (${res.status}): ${text.slice(0, 200)}`);
  },

  async unfavorite(site, postId) {
    if (!site.username || !site.apiKey) throw new Error(`${site.name} credentials missing`);
    const res = await fetch(safeJoin(site.baseUrl, `/favorites/${postId}.json`), {
      method: 'DELETE',
      headers: buildHeaders(site)
    });
    if (res.ok || res.status === 404) return;
    const text = await res.text();
    throw new Error(`${site.name} unfavorite failed (${res.status}): ${text.slice(0, 200)}`);
  },

  extractIdFromUrl(url, site) {
    const host = new URL(site.baseUrl).hostname.replace(/^www\./, '').toLowerCase();
    const match = url.match(danbooruRegex(host));
    if (!match?.[1]) return null;
    return { remoteId: match[1] };
  },

  buildPostUrl(site, postId) {
    return safeJoin(site.baseUrl, `/posts/${postId}`);
  }
};
