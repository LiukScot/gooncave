import { fetch } from 'undici';

import { config } from '../../config';

import { escapeRegex, normalizeTag, safeJoin } from './helpers';
import type { BooruEngineModule, TagResult } from './types';

type MoebooruPost = {
  id?: number | string | null;
  file_url?: string | null;
  preview_url?: string | null;
  sample_url?: string | null;
  jpeg_url?: string | null;
  width?: number | null;
  height?: number | null;
  rating?: string | null;
  md5?: string | null;
  tags?: string | null;
  tags_general?: string | null;
  tags_artist?: string | null;
  tags_character?: string | null;
  tags_copyright?: string | null;
  tags_meta?: string | null;
};

type MoebooruResponse = MoebooruPost[] | MoebooruPost;

const userAgent = () => config.e621.userAgent;


const buildHeaders = (): Record<string, string> => ({ 'User-Agent': userAgent() });

const moebooruRegex = (host: string) =>
  new RegExp(`^https?://(?:www\\.)?${escapeRegex(host)}/post/show/(\\d+)`, 'i');

export const moebooruEngine: BooruEngineModule = {
  type: 'moebooru',
  credentialSchema: 'none',
  defaultCapabilities: { favorites: false, tags: true, sourceMatch: true, search: true },
  defaultUserAgent: '',
  probePath: '/post.json?limit=1',
  probeMatches: (body: unknown): boolean => {
    if (!Array.isArray(body) || body.length === 0) return false;
    const first = body[0];
    if (!first || typeof first !== 'object') return false;
    const post = first as MoebooruPost;
    const tagStr = (post as { tag_string_general?: unknown }).tag_string_general;
    if (typeof tagStr === 'string') return false; // would match danbooru
    return typeof post.tags === 'string' && typeof post.md5 === 'string';
  },
  probeSample: (body: unknown) => {
    const post = Array.isArray(body) ? (body[0] as MoebooruPost | undefined) : null;
    if (!post?.id) return null;
    const id = String(post.id);
    return {
      postId: id,
      thumbUrl: post.preview_url ?? null,
      postPath: `/post/show/${id}`
    };
  },

  async fetchPostTags(site, postId): Promise<TagResult[]> {
    const endpoints = [
      safeJoin(site.baseUrl, `/post/show/${postId}.json`),
      safeJoin(site.baseUrl, `/post.json?tags=id:${postId}`)
    ];
    for (const endpoint of endpoints) {
      const res = await fetch(endpoint, { headers: buildHeaders() });
      const text = await res.text();
      if (!res.ok) {
        console.warn(`[tags] moebooru fetch failed (${res.status}): ${text.slice(0, 200)}`);
        continue;
      }
      let data: MoebooruResponse;
      try {
        data = JSON.parse(text) as MoebooruResponse;
      } catch {
        console.warn(`[tags] moebooru parse failed: ${text.slice(0, 200)}`);
        continue;
      }
      const entry = Array.isArray(data) ? data[0] : data;
      if (!entry) continue;
      const bucket: TagResult[] = [];
      const pushTags = (category: string, value?: string | null) => {
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
      return bucket;
    }
    return [];
  },

  extractIdFromUrl(url, site) {
    const host = new URL(site.baseUrl).hostname.replace(/^www\./, '').toLowerCase();
    const match = url.match(moebooruRegex(host));
    if (!match?.[1]) return null;
    return { remoteId: match[1] };
  },

  buildPostUrl(site, postId) {
    return safeJoin(site.baseUrl, `/post/show/${postId}`);
  }
};
