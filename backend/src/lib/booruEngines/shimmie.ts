import { fetch } from 'undici';

import { config } from '../../config';

import { escapeRegex, normalizeTag, safeJoin } from './helpers';
import type { BooruEngineModule, TagResult } from './types';

// Shimmie2 (https://code.shishnet.org/shimmie2/) ships a Danbooru-compatible
// XML API at /api/danbooru/find_posts/index.xml. Some forks also expose
// /index.php?q=api/danbooru/find_posts/index.xml when clean URLs are off, but
// the canonical clean form below works on the reference installs we have
// tested. Response shape:
//
//   <posts count="N" offset="0">
//     <tag name="..." count="X" type="general"/>
//     <post id="123" md5="..." file_url="..." preview_url="..."
//           tags="a b c" rating="s" .../>
//   </posts>
//
// We do not pull in an XML parser dependency just for shape detection +
// single-post extraction. Regex against well-formed shimmie attributes is
// good enough; if we later need full XML parsing we can swap in fast-xml-
// parser without changing the public engine interface.

const userAgent = () => config.e621.userAgent;

// Shimmie's "Danbooru compat" auth uses login + password_hash query params
// (SHA1 of password + site-specific salt), which we can't reproduce from
// API-key style input. The probe / tag-fetch endpoints are typically public,
// so we send no auth header — credentialSchema is 'none' accordingly.
const buildHeaders = (): Record<string, string> => ({
  'User-Agent': userAgent(),
  Accept: 'application/xml, text/xml;q=0.9, */*;q=0.5'
});

const shimmieRegex = (host: string) =>
  // Shimmie post page is /post/view/{id}
  new RegExp(`^https?://(?:www\\.)?${escapeRegex(host)}/post/view/(\\d+)`, 'i');

const POST_TAG = /<post\b[^>]*?>/i;
const POSTS_TAG = /<posts\b[^>]*?>/i;
const ATTR_RE = (name: string) => new RegExp(`\\b${name}="([^"]*)"`, 'i');

const extractAttribute = (xml: string, name: string): string | null => {
  const match = xml.match(ATTR_RE(name));
  return match?.[1] ?? null;
};

const findFirstPost = (xml: string): string | null => {
  const match = xml.match(POST_TAG);
  return match?.[0] ?? null;
};

const looksLikeShimmieResponse = (text: string): boolean => {
  // Reject things that obviously aren't XML (HTML, JSON, plain text).
  if (!text || text.length < 10) return false;
  if (text.trimStart().startsWith('<!DOCTYPE html')) return false;
  if (text.trimStart().startsWith('{')) return false;
  return POSTS_TAG.test(text);
};

export const shimmieEngine: BooruEngineModule = {
  type: 'shimmie',
  credentialSchema: 'none',
  defaultCapabilities: {
    favorites: false,
    tags: true,
    sourceMatch: true,
    search: true
  },
  defaultUserAgent: '',
  probePath: '/api/danbooru/find_posts/index.xml?limit=1',
  probeMatches: (body: unknown): boolean => {
    if (typeof body !== 'string') return false;
    if (!looksLikeShimmieResponse(body)) return false;
    // Either zero posts (`<posts count="0" .../>` empty board, still a
    // valid shimmie) or at least one `<post .../>` with required attrs.
    const first = findFirstPost(body);
    if (!first) {
      // empty board: `<posts ...>...</posts>` with no <post> entries
      return /<posts\b[^>]*count="\d+"/i.test(body);
    }
    const id = extractAttribute(first, 'id');
    const tags = extractAttribute(first, 'tags');
    return !!id && typeof tags === 'string';
  },
  probeSample: (body: unknown) => {
    if (typeof body !== 'string') return null;
    const first = findFirstPost(body);
    if (!first) return null;
    const id = extractAttribute(first, 'id');
    if (!id) return null;
    return {
      postId: id,
      thumbUrl: extractAttribute(first, 'preview_url') ?? null,
      postPath: `/post/view/${id}`
    };
  },

  async fetchPostTags(site, postId) {
    // Shimmie's per-post XML endpoint mirrors danbooru's query interface.
    const params = new URLSearchParams({ tags: `id:${postId}`, limit: '1' });
    const res = await fetch(
      safeJoin(
        site.baseUrl,
        `/api/danbooru/find_posts/index.xml?${params.toString()}`
      ),
      {
        headers: buildHeaders()
      }
    );
    const text = await res.text();
    if (!res.ok) {
      console.warn(
        `[tags] shimmie fetch failed (${res.status}): ${text.slice(0, 200)}`
      );
      return [];
    }
    const first = findFirstPost(text);
    if (!first) return [];
    const tagsAttr = extractAttribute(first, 'tags');
    if (!tagsAttr) return [];
    // Shimmie returns space-separated underscore tags. No per-category info
    // is available via the danbooru-compat endpoint — everything is
    // imported as "general"; users can re-categorise via the manual tag
    // workflow if needed.
    return tagsAttr
      .split(/\s+/)
      .map((tag) => normalizeTag(tag))
      .filter(Boolean)
      .map((tag) => ({ tag, category: 'general' }) as TagResult);
  },

  extractIdFromUrl(url, site) {
    const host = new URL(site.baseUrl).hostname
      .replace(/^www\./, '')
      .toLowerCase();
    const match = url.match(shimmieRegex(host));
    if (!match?.[1]) return null;
    return { remoteId: match[1] };
  },

  buildPostUrl(site, postId) {
    return safeJoin(site.baseUrl, `/post/view/${postId}`);
  }
};
