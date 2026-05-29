import { fetch } from 'undici';

import { config } from '../../config';
import type { BooruSiteRecord } from '../dataStore';

import { normalizeTag, safeJoin } from './helpers';
import type { BooruEngineModule, BooruRemoteFavorite, FetchFavoritesContext, TagResult } from './types';

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

const FAV_HTML_PAGE_SIZE = 50;
const FAV_HTML_SLEEP_MS = 200;
const FAV_POST_SLEEP_MS = 100;
// Safety cap. 1000 pages × 50 posts/page = 50k favorites max; a runaway HTML
// server or pathological dataset shouldn't loop forever.
const FAV_MAX_HTML_PAGES = 1000;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Favorites fetch aborted')); return; }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(id); reject(new Error('Favorites fetch aborted')); }, { once: true });
  });

// Scrape post IDs from the HTML favorites page (paginated by pid).
// Gelbooru-style API has no fav-by-user-id endpoint and fav: tag requires
// username (not user_id), so we read the public HTML page instead.
const scrapeFavoritePostIds = async (
  site: BooruSiteRecord,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  onPage?: (page: number, count: number) => void
): Promise<string[]> => {
  const seen = new Set<string>();
  for (let page = 0; page < FAV_MAX_HTML_PAGES; page += 1) {
    if (signal?.aborted) throw new Error('Favorites fetch aborted');
    const pid = page * FAV_HTML_PAGE_SIZE;
    const url = `${site.baseUrl.replace(/\/+$/, '')}/index.php?page=favorites&s=view&id=${encodeURIComponent(site.username!)}&pid=${pid}`;
    const res = await fetch(url, { headers, signal });
    if (!res.ok) {
      throw new Error(`${site.name} favorites page failed (${res.status})`);
    }
    const html = await res.text();
    const ids = [...new Set([...html.matchAll(/page=post&amp;s=view&amp;id=(\d+)/g)].map((m) => m[1]))];
    const fresh = ids.filter((id) => !seen.has(id));
    if (fresh.length === 0) break;
    fresh.forEach((id) => seen.add(id));
    onPage?.(page + 1, fresh.length);
    if (ids.length < FAV_HTML_PAGE_SIZE) break;
    await sleep(FAV_HTML_SLEEP_MS, signal);
  }
  return Array.from(seen);
};

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
  defaultCapabilities: { favorites: true, tags: true, sourceMatch: true, search: true },
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

  async fetchFavorites(site, ctx?: FetchFavoritesContext): Promise<{ items: BooruRemoteFavorite[]; downloadHeaders: Record<string, string> }> {
    if (!site.username || !site.apiKey) {
      throw new Error(`${site.name} credentials missing`);
    }
    const { signal } = ctx ?? {};
    const headers = buildHeaders();
    // Gelbooru's API has no usable "fetch favorites by user_id" endpoint
    // (the fav: tag needs the login username, not the numeric ID, and there's
    // no public lookup from ID to username). The HTML favorites page IS keyed
    // by user_id, so scrape that for post IDs, then resolve each via the API.
    const postIds = await scrapeFavoritePostIds(site, headers, signal, ctx?.onPage);
    const items: BooruRemoteFavorite[] = [];
    for (const postId of postIds) {
      if (signal?.aborted) throw new Error('Favorites fetch aborted');
      const params = buildBaseQuery(site, { id: postId, limit: '1' });
      const res = await fetch(safeJoin(site.baseUrl, `/index.php?${params.toString()}`), { headers, signal });
      const text = await res.text();
      // Dead/deleted post → skip silently; the HTML page can list stale IDs.
      if (!res.ok || !text.trim()) continue;
      let data: GelbooruResponse;
      try {
        data = JSON.parse(text) as GelbooruResponse;
      } catch {
        continue; // malformed single-post response → skip
      }
      // Rule34/Gelbooru forks return 200 with a JSON-string error message
      // (e.g. "Missing authentication") — surface it as a real failure so the
      // user knows credentials are bad, instead of silently producing 0 items.
      if (typeof data === 'string') {
        throw new Error(`${site.name} favorites failed: ${(data as string).slice(0, 200)}`);
      }
      const post = extractPosts(data)[0];
      const id = post?.id ? String(post.id) : null;
      if (!id) continue;
      items.push({
        provider: site.id,
        remoteId: id,
        sourceUrl: `${site.baseUrl.replace(/\/+$/, '')}/index.php?page=post&s=view&id=${id}`,
        fileUrl: post.file_url ?? post.sample_url ?? null
      });
      await sleep(FAV_POST_SLEEP_MS, signal);
    }
    return { items, downloadHeaders: headers };
  },

  async unfavorite(site, postId) {
    if (!site.username || !site.apiKey) throw new Error(`${site.name} credentials missing`);
    const params = new URLSearchParams({
      page: 'favorites',
      s: 'delete',
      id: postId,
      user_id: site.username,
      api_key: site.apiKey
    });
    const res = await fetch(safeJoin(site.baseUrl, `/index.php?${params.toString()}`), {
      headers: buildHeaders(),
      redirect: 'manual'
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') ?? '';
      throw new Error(`${site.name} unfavorite redirected (${res.status}) to ${location || 'unknown location'}`);
    }
    // 404 means the favorite was already absent, so remote state is satisfied.
    if (res.ok || res.status === 404) return;
    const text = await res.text();
    throw new Error(`${site.name} unfavorite failed (${res.status}): ${text.slice(0, 200)}`);
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
