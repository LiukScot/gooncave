import { fetch } from 'undici';

import { config } from '../../config';
import type { BooruSiteRecord } from '../../db/types';

import {
  extensionOf,
  idAtAge,
  normalizeTag,
  safeJoin,
  toIsoOrNull,
  toNumberOrNull,
  WINDOW_SECONDS
} from './helpers';
import type {
  BooruEngineModule,
  BooruRemoteFavorite,
  FetchFavoritesContext,
  RemotePost,
  TagResult
} from './types';
import { windowRange } from './windowRange';

type GelbooruPost = {
  id?: number | string | null;
  file_url?: string | null;
  preview_url?: string | null;
  sample_url?: string | null;
  width?: number | null;
  height?: number | null;
  score?: number | null;
  md5?: string | null;
  /** rule34-style forks call md5 "hash". */
  hash?: string | null;
  created_at?: string | null;
  /** unix seconds of last change; created_at fallback on forks. */
  change?: number | null;
  rating?: string | null;
  tags?: string | null;
  /** Gelbooru forks name the uploading account `owner`. */
  owner?: string | null;
};

type GelbooruEnvelope = {
  post?: GelbooruPost | GelbooruPost[] | null;
};

type GelbooruResponse = GelbooruPost[] | GelbooruEnvelope | GelbooruPost;

const userAgent = () => config.e621.userAgent;

const buildHeaders = (): Record<string, string> => ({
  'User-Agent': userAgent()
});

// Like buildHeaders, but attaches the optional session cookie for authenticated
// actions (issue #144). The Cookie value is a sensitive credential: never log
// this header or include it in error messages.
const buildAuthHeaders = (site: BooruSiteRecord): Record<string, string> => {
  const headers = buildHeaders();
  if (site.sessionCookie) headers.Cookie = site.sessionCookie;
  return headers;
};

const buildBaseQuery = (
  site: BooruSiteRecord,
  extra: Record<string, string>
): URLSearchParams => {
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
    if (signal?.aborted) {
      reject(new Error('Favorites fetch aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(id);
      reject(new Error('Favorites fetch aborted'));
    };
    // Drop the abort listener when the timer wins, otherwise a large favorites
    // sync (thousands of sleeps on one signal) leaks a handler per call.
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
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
  if (!site.username) throw new Error('Gelbooru favorites requires a username');
  const seen = new Set<string>();
  for (let page = 0; page < FAV_MAX_HTML_PAGES; page += 1) {
    if (signal?.aborted) throw new Error('Favorites fetch aborted');
    const pid = page * FAV_HTML_PAGE_SIZE;
    const url = `${site.baseUrl.replace(/\/+$/, '')}/index.php?page=favorites&s=view&id=${encodeURIComponent(site.username)}&pid=${pid}`;
    const res = await fetch(url, { headers, signal });
    if (!res.ok) {
      throw new Error(`${site.name} favorites page failed (${res.status})`);
    }
    const html = await res.text();
    const ids = [
      ...new Set(
        [...html.matchAll(/page=post&amp;s=view&amp;id=(\d+)/g)].map(
          (m) => m[1]
        )
      )
    ];
    const fresh = ids.filter((id) => !seen.has(id));
    if (fresh.length === 0) break;
    fresh.forEach((id) => seen.add(id));
    onPage?.(page + 1, fresh.length);
    if (ids.length < FAV_HTML_PAGE_SIZE) break;
    await sleep(FAV_HTML_SLEEP_MS, signal);
  }
  return Array.from(seen);
};

// Re-fetch the user's public favorites page and report whether `postId` is
// still listed. The delete endpoint redirects without proving removal (issue
// #144), so this is how we confirm a reverse-delete actually took effect.
// Reads the public page (no cookie needed); the page is keyed by user_id.
const isFavoritedRemotely = async (
  site: BooruSiteRecord,
  postId: string
): Promise<boolean> => {
  const ids = await scrapeFavoritePostIds(site, buildHeaders(), undefined);
  return ids.includes(postId);
};

// How far back the second sample sits. Wide enough to span roughly two days
// of uploads on a busy board, which is what makes the rate stable: a sample
// minutes wide reads whatever burst is happening right now and was off by
// 26% when measured against rule34.
const ID_RATE_SAMPLE_SPAN = 20_000;
// The upload rate drifts over hours, not minutes.
const ID_RATE_TTL_MS = 60 * 60 * 1000;

type IdRate = { measuredAt: number; newestId: number; idsPerSecond: number };

const idRateBySite = new Map<string, IdRate>();

const fetchOnePost = async (
  site: BooruSiteRecord,
  extra: Record<string, string>
): Promise<GelbooruPost | null> => {
  const params = buildBaseQuery(site, { limit: '1', ...extra });
  const res = await fetch(
    safeJoin(site.baseUrl, `/index.php?${params.toString()}`),
    { headers: buildHeaders() }
  );
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    const data = JSON.parse(text) as GelbooruResponse;
    if (typeof data === 'string') return null;
    return extractPosts(data)[0] ?? null;
  } catch {
    return null;
  }
};

/**
 * Lowest post id still inside a window `seconds` wide, or 0 when the rate
 * cannot be measured (the caller then leaves the search unbounded).
 *
 * Gelbooru rejects every date metatag, so the window has to be expressed as
 * `id:>N`. Ids advance at the board's upload rate, measured from two real
 * posts rather than assumed, and cached because it barely moves.
 */
const oldestIdWithin = async (
  site: BooruSiteRecord,
  seconds: number
): Promise<number> => {
  const cached = idRateBySite.get(site.id);
  const fresh =
    cached && Date.now() - cached.measuredAt < ID_RATE_TTL_MS ? cached : null;
  if (fresh) {
    return Math.max(
      0,
      Math.round(fresh.newestId - fresh.idsPerSecond * seconds)
    );
  }

  const newest = await fetchOnePost(site, {});
  const newestId = Number(newest?.id);
  const newestAt = Number(newest?.change);
  if (!Number.isFinite(newestId) || !Number.isFinite(newestAt)) return 0;

  const older = await fetchOnePost(site, {
    tags: `id:<${newestId - ID_RATE_SAMPLE_SPAN}`
  });
  const olderId = Number(older?.id);
  const olderAt = Number(older?.change);
  if (!Number.isFinite(olderId) || !Number.isFinite(olderAt)) return 0;

  const elapsed = newestAt - olderAt;
  const travelled = newestId - olderId;
  if (elapsed <= 0 || travelled <= 0) return 0;

  const idsPerSecond = travelled / elapsed;
  idRateBySite.set(site.id, { measuredAt: Date.now(), newestId, idsPerSecond });
  return idAtAge(newestId, newestAt, olderId, olderAt, seconds);
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

/**
 * Tag categories, which the JSON API does not report at all. The post page
 * files every tag under a `tag-type-*` class, so that is where they come
 * from. Names are read from the wiki link rather than the visible label:
 * the label is the display form ("big breasts"), the link carries the real
 * underscored tag.
 *
 * Gelbooru escapes the ampersands in that href and rule34 does not, so the
 * separator before `search=` is `&` on one and `;` (the tail of `&amp;`) on
 * the other.
 */
const TAG_LI_RE =
  /<li[^>]*class="[^"]*tag-type-([a-z]+)[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
const TAG_NAME_RE = /[?&;]search=([^"&]+)/i;

// Gelbooru calls it "metadata"; every other engine here reports "meta".
const GELBOORU_CATEGORIES: Record<string, string> = { metadata: 'meta' };

export const parsePostPageTags = (html: string): TagResult[] => {
  const seen = new Set<string>();
  const tags: TagResult[] = [];
  for (const [, rawCategory, body] of html.matchAll(TAG_LI_RE)) {
    const name = TAG_NAME_RE.exec(body)?.[1];
    if (!name) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      // A malformed escape means this one link is unreadable, not that the
      // page is: keep the rest of the tags.
      continue;
    }
    const tag = normalizeTag(decoded);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push({
      tag,
      category: GELBOORU_CATEGORIES[rawCategory] ?? rawCategory
    });
  }
  return tags;
};

export const gelbooruEngine: BooruEngineModule = {
  type: 'gelbooru',
  credentialSchema: 'userid+apikey',
  supportsSessionCookie: true,
  defaultCapabilities: {
    favorites: true,
    tags: true,
    sourceMatch: true,
    search: true,
    vote: false
  },
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
    return (
      typeof p.tags === 'string' &&
      (typeof p.file_url === 'string' || typeof p.sample_url === 'string')
    );
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
    // The post page first: it is the only place this engine family exposes
    // tag categories (issue #311). The JSON API below is the fallback, and
    // everything it returns lands in 'general'.
    try {
      const page = await fetch(
        safeJoin(site.baseUrl, `/index.php?page=post&s=view&id=${postId}`),
        { headers: buildHeaders() }
      );
      if (page.ok) {
        const tags = parsePostPageTags(await page.text());
        if (tags.length) return tags;
      } else {
        console.warn(`[tags] gelbooru post page failed (${page.status})`);
      }
    } catch (err) {
      console.warn(`[tags] gelbooru post page failed: ${(err as Error).message}`);
    }
    const params = buildBaseQuery(site, { id: postId, limit: '1' });
    const res = await fetch(
      safeJoin(site.baseUrl, `/index.php?${params.toString()}`),
      {
        headers: buildHeaders()
      }
    );
    const text = await res.text();
    if (!res.ok) {
      console.warn(
        `[tags] gelbooru fetch failed (${res.status}): ${text.slice(0, 200)}`
      );
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

  async searchPosts(site, options) {
    const tags = [...options.tags];
    if (options.sort !== 'new') {
      tags.push('sort:score');
      // Without bounds this ranks the site's best posts of all time, which is
      // not what either Hot or Popular asks for. Hot gets the last day: the
      // engine has no age-weighted ranking, so "the best of what is new" is
      // as close as it gets. Popular gets the calendar period the user is
      // looking at, translated into ids because no date metatag is accepted.
      const now = Date.now();
      const period =
        options.sort === 'hot'
          ? { fromMsAgo: WINDOW_SECONDS.day * 1000, toMsAgo: 0 }
          : (() => {
              const range = windowRange(options.window, options.date);
              return {
                fromMsAgo: now - Date.parse(`${range.start}T00:00:00.000Z`),
                // End of the last day in the period.
                toMsAgo: now - Date.parse(`${range.end}T23:59:59.999Z`)
              };
            })();
      const floor = await oldestIdWithin(site, period.fromMsAgo / 1000);
      if (floor > 0) tags.push(`id:>${floor}`);
      // A period that has already ended also needs a ceiling, or it would
      // run all the way to today's posts.
      if (period.toMsAgo > 0) {
        const ceiling = await oldestIdWithin(site, period.toMsAgo / 1000);
        if (ceiling > 0) tags.push(`id:<${ceiling}`);
      }
    }
    const params = buildBaseQuery(site, {
      tags: tags.join(' '),
      limit: String(options.limit),
      pid: String(options.page - 1)
    });
    const headers = buildHeaders();
    const res = await fetch(
      safeJoin(site.baseUrl, `/index.php?${params.toString()}`),
      { headers }
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `${site.name} search failed (${res.status}): ${text.slice(0, 200)}`
      );
    }
    const data = JSON.parse(text) as GelbooruResponse;
    if (typeof data === 'string') {
      throw new Error(
        `${site.name} search failed: ${String(data).slice(0, 200)}`
      );
    }
    const posts: RemotePost[] = [];
    for (const post of extractPosts(data)) {
      if (!post?.id) continue;
      posts.push({
        remoteId: String(post.id),
        previewUrl: post.preview_url ?? null,
        sampleUrl: post.sample_url ?? null,
        fileUrl: post.file_url ?? post.sample_url ?? null,
        width: toNumberOrNull(post.width),
        height: toNumberOrNull(post.height),
        score: toNumberOrNull(post.score),
        rating: post.rating ?? null,
        md5: post.md5 ?? post.hash ?? null,
        createdAt: toIsoOrNull(post.created_at ?? post.change ?? null),
        // No category information on this API: everything lands in general.
        tags: (post.tags ?? '')
          .split(' ')
          .map((tag) => normalizeTag(tag))
          .filter(Boolean)
          .map((tag) => ({ tag, category: 'general' })),
        favCount: null,
        uploader: post.owner ?? null,
        fileExt: extensionOf(post.file_url ?? null),
        fileSize: null,
        favorited: null,
        voted: null
      });
    }
    return { posts, downloadHeaders: headers };
  },

  async fetchFavorites(
    site,
    ctx?: FetchFavoritesContext
  ): Promise<{
    items: BooruRemoteFavorite[];
    downloadHeaders: Record<string, string>;
  }> {
    if (!site.username || !site.apiKey) {
      throw new Error(`${site.name} credentials missing`);
    }
    const { signal } = ctx ?? {};
    const headers = buildHeaders();
    // Gelbooru's API has no usable "fetch favorites by user_id" endpoint
    // (the fav: tag needs the login username, not the numeric ID, and there's
    // no public lookup from ID to username). The HTML favorites page IS keyed
    // by user_id, so scrape that for post IDs, then resolve each via the API.
    const postIds = await scrapeFavoritePostIds(
      site,
      headers,
      signal,
      ctx?.onPage
    );
    const items: BooruRemoteFavorite[] = [];
    for (const postId of postIds) {
      if (signal?.aborted) throw new Error('Favorites fetch aborted');
      const params = buildBaseQuery(site, { id: postId, limit: '1' });
      const res = await fetch(
        safeJoin(site.baseUrl, `/index.php?${params.toString()}`),
        { headers, signal }
      );
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
        throw new Error(
          `${site.name} favorites failed: ${(data as string).slice(0, 200)}`
        );
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

  /**
   * Gelbooru's JSON API has no endpoint for adding a favorite — only the
   * site's own action does it, and that one authenticates by session cookie
   * rather than api_key. Same shape as unfavorite (issue #144): the response
   * proves nothing on its own, so the favorites page is re-read to confirm.
   * Never log or echo the cookie.
   *
   * Current forks add through `public/addfav.php`, the endpoint the site's
   * own "Add to favorites" link calls. The 0.2-era
   * `index.php?page=favorites&s=add` is kept only as a fallback for a fork
   * that lacks the newer one: rule34.xxx answers that URL 200 with an empty
   * page and adds nothing, which is what made favoriting look broken while
   * reporting a bad session cookie.
   */
  async favorite(site, postId) {
    if (!site.sessionCookie) {
      throw new Error(
        `${site.name} needs a session cookie to add favorites: copy it from your browser in Settings → Favorites accounts`
      );
    }
    // Mirrors the call the site's own page makes.
    const headers = {
      ...buildAuthHeaders(site),
      'X-Requested-With': 'XMLHttpRequest'
    };
    let res = await fetch(
      safeJoin(
        site.baseUrl,
        `/public/addfav.php?id=${encodeURIComponent(postId)}`
      ),
      { headers, redirect: 'manual' }
    );
    if (res.status === 404) {
      const params = new URLSearchParams({
        page: 'favorites',
        s: 'add',
        id: postId
      });
      res = await fetch(
        safeJoin(site.baseUrl, `/index.php?${params.toString()}`),
        { headers, redirect: 'manual' }
      );
    }
    if (res.status >= 400) {
      const text = await res.text();
      throw new Error(
        `${site.name} favorite failed (${res.status}): ${text.slice(0, 200)}`
      );
    }
    // Adding an existing favorite is a no-op on the site, so a post already
    // in the list counts as success either way.
    if (await isFavoritedRemotely(site, postId)) return;
    throw new Error(
      `${site.name} favorite not confirmed — the session cookie may be expired or invalid. Re-copy it from your browser and save it again.`
    );
  },

  async unfavorite(site, postId) {
    if (!site.username || !site.apiKey)
      throw new Error(`${site.name} credentials missing`);
    const params = new URLSearchParams({
      page: 'favorites',
      s: 'delete',
      id: postId,
      user_id: site.username,
      api_key: site.apiKey
    });
    const res = await fetch(
      safeJoin(site.baseUrl, `/index.php?${params.toString()}`),
      {
        headers: buildAuthHeaders(site),
        redirect: 'manual'
      }
    );

    // 404 = favorite already absent; remote state is already satisfied.
    if (res.status === 404) return;
    // Hard failures (auth rejected, server error) surface immediately and are
    // never swallowed. A 3xx redirect is NOT treated as failure here: Gelbooru
    // redirects back to the favorites page on both success and no-op, so the
    // redirect alone proves nothing (issue #144) — verification decides.
    if (res.status >= 400) {
      const text = await res.text();
      throw new Error(
        `${site.name} unfavorite failed (${res.status}): ${text.slice(0, 200)}`
      );
    }

    // The response can't prove the favorite was removed. Re-fetch the live
    // favorites list and confirm before claiming success.
    if (!(await isFavoritedRemotely(site, postId))) return;

    // Still favorited: the delete didn't take. Surface an actionable reason
    // without ever echoing the cookie value (issue #144).
    throw new Error(
      site.sessionCookie
        ? `${site.name} remote unfavorite not confirmed — the session cookie may be expired or invalid. Re-copy it from your browser and save it again.`
        : `${site.name} remote unfavorite not confirmed — add a session cookie for this site to enable remote delete.`
    );
  },

  async checkSessionCookie(site) {
    if (!site.sessionCookie)
      return { ok: false, error: 'no session cookie saved' };
    try {
      // Account pages are login-gated. We send the cookie and look for the
      // logout link, which only renders when authenticated. Never echo the
      // cookie value.
      const url = `${site.baseUrl.replace(/\/+$/, '')}/index.php?page=account&s=home`;
      const res = await fetch(url, {
        headers: buildAuthHeaders(site),
        redirect: 'manual'
      });
      // Logged out, the account page bounces to the login screen.
      if (res.status >= 300 && res.status < 400) {
        return {
          ok: false,
          error: 'not authenticated (redirected) — cookie expired or incomplete'
        };
      }
      if (!res.ok) {
        return { ok: false, error: `account page returned ${res.status}` };
      }
      const html = await res.text();
      // Rule34/Gelbooru's logout link is `page=account&s=login&code=01` — the
      // `code=01` is what distinguishes logout from the plain login form. It's
      // in the nav on every page once authenticated, so its presence proves the
      // cookie works. (Confirmed against rule34.xxx — issue #144.) Tolerate HTML
      // entity-encoded ampersands (`&amp;`). Other Gelbooru forks may render the
      // logout link differently — there this advisory may false-negative, but
      // the authoritative removal proof is the favorites re-fetch in
      // unfavorite(), which is fork-agnostic, so a wrong answer never blocks a
      // real delete.
      if (/s=login&(?:amp;)?code=01/i.test(html)) return { ok: true };
      return {
        ok: false,
        error: 'not authenticated — cookie expired, incomplete, or wrong'
      };
    } catch (err) {
      // Transport/parse failure: report it as a cookie-status failure so the
      // /test route stays a 200 with a status object (never a 500). The message
      // can't contain the cookie — it's only in the request headers.
      return {
        ok: false,
        error: `cookie check failed: ${(err as Error).message}`
      };
    }
  },

  extractIdFromUrl(url, site) {
    try {
      const parsed = new URL(url);
      const siteHost = new URL(site.baseUrl).hostname
        .replace(/^www\./, '')
        .toLowerCase();
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
    return safeJoin(site.baseUrl, `/index.php?page=post&s=view&id=${postId}`);
  }
};
