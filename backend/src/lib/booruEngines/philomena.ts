import { fetch } from 'undici';

import { config } from '../../config';
import type { BooruSiteRecord } from '../../db/types';

import {
  escapeRegex,
  normalizeTag,
  safeJoin,
  toIsoOrNull,
  toNumberOrNull
} from './helpers';
import type { BooruEngineModule, RemotePost, TagResult } from './types';
import { windowRange } from './windowRange';

type PhilomenaImage = {
  id?: number | string | null;
  view_url?: string | null;
  representations?: {
    thumb?: string | null;
    medium?: string | null;
    large?: string | null;
    full?: string | null;
  } | null;
  width?: number | null;
  height?: number | null;
  score?: number | null;
  faves?: number | null;
  uploader?: string | null;
  format?: string | null;
  size?: number | null;
  sha512_hash?: string | null;
  created_at?: string | null;
  tag_count?: number | null;
  tags?: string[] | null;
  rating?: string | null;
};

type PhilomenaSearchResponse = {
  images?: PhilomenaImage[] | null;
};

type PhilomenaImageResponse = {
  image?: PhilomenaImage | null;
};

const userAgent = () => config.e621.userAgent;

const buildHeaders = (site: BooruSiteRecord): Record<string, string> => ({
  'User-Agent': userAgent(),
  ...(site.apiKey ? { 'x-philomena-api-key': site.apiKey } : {})
});

const philomenaRegex = (host: string) =>
  new RegExp(`^https?://(?:www\\.)?${escapeRegex(host)}/images/(\\d+)`, 'i');

export const philomenaEngine: BooruEngineModule = {
  type: 'philomena',
  credentialSchema: 'apikey-only',
  defaultCapabilities: {
    favorites: false,
    tags: true,
    sourceMatch: true,
    search: true,
    vote: false
  },
  defaultUserAgent: '',
  probePath: '/api/v1/json/search/images?per_page=1',
  probeMatches: (body: unknown): boolean => {
    if (!body || typeof body !== 'object') return false;
    const images = (body as PhilomenaSearchResponse).images;
    if (!Array.isArray(images) || images.length === 0) return false;
    const first = images[0];
    return !!first && Array.isArray(first.tags);
  },
  probeSample: (body: unknown) => {
    const images = (body as PhilomenaSearchResponse | null)?.images;
    const image = Array.isArray(images) ? images[0] : null;
    if (!image?.id) return null;
    const id = String(image.id);
    return {
      postId: id,
      thumbUrl:
        image.representations?.thumb ?? image.representations?.medium ?? null,
      postPath: `/images/${id}`
    };
  },

  async searchPosts(site, options) {
    // philomena search is query-based, not metatag-based: * matches all
    const query = options.tags.length ? options.tags.join(' AND ') : '*';
    const params = new URLSearchParams({
      q: query,
      per_page: String(options.limit),
      page: String(options.page),
      sd: 'desc'
    });
    if (options.sort === 'hot') {
      params.set('sf', 'wilson_score');
    } else if (options.sort === 'popular') {
      params.set('sf', 'score');
      const period = windowRange(options.window, options.date);
      params.set(
        'q',
        `(${query}) AND created_at.gte:${period.start} AND created_at.lte:${period.end}`
      );
    } else {
      params.set('sf', 'created_at');
    }
    const headers = buildHeaders(site);
    const res = await fetch(
      safeJoin(site.baseUrl, `/api/v1/json/search/images?${params.toString()}`),
      { headers }
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `${site.name} search failed (${res.status}): ${text.slice(0, 200)}`
      );
    }
    const data = JSON.parse(text) as PhilomenaSearchResponse;
    const posts: RemotePost[] = [];
    for (const image of data.images ?? []) {
      if (!image?.id) continue;
      posts.push({
        remoteId: String(image.id),
        previewUrl:
          image.representations?.thumb ?? image.representations?.medium ?? null,
        sampleUrl:
          image.representations?.large ?? image.representations?.medium ?? null,
        fileUrl: image.view_url ?? image.representations?.full ?? null,
        width: toNumberOrNull(image.width),
        height: toNumberOrNull(image.height),
        score: toNumberOrNull(image.score),
        rating: null,
        md5: null,
        createdAt: toIsoOrNull(image.created_at),
        tags: (image.tags ?? [])
          .map((tag) => normalizeTag(tag))
          .filter(Boolean)
          .map((tag) => ({ tag, category: 'general' })),
        favCount: toNumberOrNull(image.faves),
        uploader: image.uploader ?? null,
        fileExt: image.format ?? null,
        fileSize: toNumberOrNull(image.size),
        favorited: null,
        voted: null
      });
    }
    return { posts, downloadHeaders: headers };
  },

  async fetchPostTags(site, postId): Promise<TagResult[]> {
    const url = safeJoin(site.baseUrl, `/api/v1/json/images/${postId}`);
    const res = await fetch(url, { headers: buildHeaders(site) });
    const text = await res.text();
    if (!res.ok) {
      console.warn(
        `[tags] philomena fetch failed (${res.status}): ${text.slice(0, 200)}`
      );
      return [];
    }
    let data: PhilomenaImageResponse;
    try {
      data = JSON.parse(text) as PhilomenaImageResponse;
    } catch {
      console.warn(`[tags] philomena parse failed: ${text.slice(0, 200)}`);
      return [];
    }
    const tags = data.image?.tags ?? [];
    return tags
      .map((tag) => normalizeTag(tag))
      .filter(Boolean)
      .map((tag) => ({ tag, category: 'general' }));
  },

  extractIdFromUrl(url, site) {
    const host = new URL(site.baseUrl).hostname
      .replace(/^www\./, '')
      .toLowerCase();
    const match = url.match(philomenaRegex(host));
    if (!match?.[1]) return null;
    return { remoteId: match[1] };
  },

  buildPostUrl(site, postId) {
    return safeJoin(site.baseUrl, `/images/${postId}`);
  }
};
