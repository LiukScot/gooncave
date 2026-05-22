import { fetch } from 'undici';

import { config } from '../../config';
import type { BooruSiteRecord } from '../dataStore';

import { normalizeTag, safeJoin } from './helpers';
import type { BooruEngineModule, TagResult } from './types';

type PhilomenaImage = {
  id?: number | string | null;
  view_url?: string | null;
  representations?: {
    thumb?: string | null;
    medium?: string | null;
    full?: string | null;
  } | null;
  width?: number | null;
  height?: number | null;
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

const escapeRegex = (value: string): string => value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

const buildHeaders = (site: BooruSiteRecord): Record<string, string> => ({
  'User-Agent': userAgent(),
  ...(site.apiKey ? { 'x-philomena-api-key': site.apiKey } : {})
});

const philomenaRegex = (host: string) =>
  new RegExp(`^https?://(?:www\\.)?${escapeRegex(host)}/images/(\\d+)`, 'i');

export const philomenaEngine: BooruEngineModule = {
  type: 'philomena',
  credentialSchema: 'apikey-only',
  defaultCapabilities: { favorites: false, tags: true, sourceMatch: true, search: true },
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
      thumbUrl: image.representations?.thumb ?? image.representations?.medium ?? null,
      postPath: `/images/${id}`
    };
  },

  async fetchPostTags(site, postId): Promise<TagResult[]> {
    const url = safeJoin(site.baseUrl, `/api/v1/json/images/${postId}`);
    const res = await fetch(url, { headers: buildHeaders(site) });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`[tags] philomena fetch failed (${res.status}): ${text.slice(0, 200)}`);
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
    const host = new URL(site.baseUrl).hostname.replace(/^www\./, '').toLowerCase();
    const match = url.match(philomenaRegex(host));
    if (!match?.[1]) return null;
    return { remoteId: match[1] };
  },

  buildPostUrl(site, postId) {
    return safeJoin(site.baseUrl, `/images/${postId}`);
  }
};
