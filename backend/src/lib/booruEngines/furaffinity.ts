import { fetch as undiciFetch } from 'undici';

import { config } from '../../config';
import type { BooruSiteRecord } from '../../db/types';

import {
  assertNotChallenge,
  FurAffinityPageError,
  listingIds,
  nextFavoritesCursor,
  normalizeFurAffinityMediaUrl,
  parseFurAffinityListingPage,
  parseFurAffinityWatchlist,
  parseSubmissionPage,
  type FurAffinitySubmissionPage
} from './furaffinityHtml';
import type {
  BooruEngineModule,
  BooruRemoteFavorite,
  FetchFavoritesContext,
  TagResult
} from './types';

const FA_ORIGIN = 'https://www.furaffinity.net';
const FA_REQUEST_INTERVAL_MS = 1_000;
const FA_REQUEST_TIMEOUT_MS = 15_000;
const FA_RETRY_DELAYS_MS = [2_000, 4_000] as const;
const FA_MAX_FAVORITES_PAGES = 1_000;
const RETRYABLE_STATUS = new Set([
  429, 500, 502, 503, 504, 520, 521, 522, 523, 524
]);

type Wait = (ms: number, signal?: AbortSignal) => Promise<void>;

type FurAffinityEngineOptions = {
  fetchImpl?: typeof undiciFetch;
  minRequestIntervalMs?: number;
  requestTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  wait?: Wait;
};

type FurAffinityResponse = {
  status: number;
  body: string;
};

const abortError = () => new Error('FurAffinity request aborted');

const abortableWait: Wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const headersFor = (
  site: BooruSiteRecord,
  authenticated: boolean
): Record<string, string> => {
  const headers: Record<string, string> = {
    'User-Agent': config.e621.userAgent,
    Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  if (authenticated && site.sessionCookie) {
    headers.Cookie = site.sessionCookie;
  }
  return headers;
};

const requireCredentials = (site: BooruSiteRecord): void => {
  if (!site.username || !site.sessionCookie) {
    throw new Error(
      `${site.name} needs a username and session cookie under Settings → Favorites accounts`
    );
  }
};

const safeErrorMessage = (site: BooruSiteRecord, error: unknown): string => {
  let message = error instanceof Error ? error.message : String(error);
  if (site.sessionCookie) {
    message = message.split(site.sessionCookie).join('[redacted cookie]');
  }
  return message.replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]');
};

export const createFurAffinityEngine = (
  options: FurAffinityEngineOptions = {}
): BooruEngineModule => {
  const fetchImpl = options.fetchImpl ?? undiciFetch;
  const minRequestIntervalMs =
    options.minRequestIntervalMs ?? FA_REQUEST_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? FA_REQUEST_TIMEOUT_MS;
  const retryDelaysMs = options.retryDelaysMs ?? FA_RETRY_DELAYS_MS;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? abortableWait;

  let requestQueue = Promise.resolve();
  let nextRequestAt = 0;
  const submissionReads = new Map<
    string,
    Promise<FurAffinitySubmissionPage>
  >();

  const schedule = async <T>(
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> => {
    const previous = requestQueue;
    let release = () => {};
    requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (signal?.aborted) throw abortError();
      const delay = Math.max(0, nextRequestAt - now());
      if (delay > 0) await wait(delay, signal);
      if (signal?.aborted) throw abortError();
      nextRequestAt = now() + minRequestIntervalMs;
      return await operation();
    } finally {
      release();
    }
  };

  const request = async (
    site: BooruSiteRecord,
    path: string,
    requestOptions: {
      authenticated?: boolean;
      signal?: AbortSignal;
      allowRedirect?: boolean;
    } = {}
  ): Promise<FurAffinityResponse> => {
    const { signal } = requestOptions;
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw abortError();
      let response: FurAffinityResponse & { ok: boolean };
      try {
        response = await schedule(async () => {
          const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
          const combinedSignal = signal
            ? AbortSignal.any([signal, timeoutSignal])
            : timeoutSignal;
          const fetched = await fetchImpl(new URL(path, FA_ORIGIN), {
            headers: headersFor(site, requestOptions.authenticated ?? true),
            redirect: requestOptions.allowRedirect ? 'manual' : 'follow',
            signal: combinedSignal
          });
          return {
            status: fetched.status,
            ok: fetched.ok,
            body: await fetched.text()
          };
        }, signal);
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (attempt >= retryDelaysMs.length) {
          const message = `${site.name} request failed after retries: ${safeErrorMessage(site, error)}`;
          if (error instanceof Error) {
            error.message = message;
            error.stack = undefined;
            throw error;
          }
          throw new Error(message, { cause: error });
        }
        await wait(retryDelaysMs[attempt], signal);
        continue;
      }

      const redirectAccepted =
        requestOptions.allowRedirect &&
        response.status >= 300 &&
        response.status < 400;
      if (response.ok || redirectAccepted) {
        return { status: response.status, body: response.body };
      }
      if (
        RETRYABLE_STATUS.has(response.status) &&
        attempt < retryDelaysMs.length
      ) {
        await wait(retryDelaysMs[attempt], signal);
        continue;
      }
      throw new Error(`${site.name} request failed (${response.status})`);
    }
  };

  const readSubmission = async (
    site: BooruSiteRecord,
    postId: string,
    signal?: AbortSignal
  ): Promise<FurAffinitySubmissionPage> => {
    const fetchSubmission = async () => {
      const response = await request(site, `/view/${postId}/`, { signal });
      return parseSubmissionPage(response.body, postId);
    };
    if (signal) return fetchSubmission();

    const key = `${site.id}:${postId}`;
    const inFlight = submissionReads.get(key);
    if (inFlight) return inFlight;

    const pending = fetchSubmission();
    submissionReads.set(key, pending);
    try {
      return await pending;
    } finally {
      if (submissionReads.get(key) === pending) {
        submissionReads.delete(key);
      }
    }
  };

  const setFavoriteState = async (
    site: BooruSiteRecord,
    postId: string,
    favorited: boolean
  ): Promise<void> => {
    requireCredentials(site);
    const before = await readSubmission(site, postId);
    if (before.missing) throw new Error(`${site.name} submission not found`);
    if (favorited && before.action === 'unfav') return;
    if (!favorited && before.action === 'fav') return;
    if (!before.actionPath) {
      throw new Error(
        `${site.name} did not expose a favorite action; the session cookie may be expired`
      );
    }

    await request(site, before.actionPath, { allowRedirect: true });
    const after = await readSubmission(site, postId);
    const confirmed = favorited
      ? after.action === 'unfav'
      : after.action === 'fav';
    if (!confirmed) {
      throw new Error(
        `${site.name} ${favorited ? 'favorite' : 'unfavorite'} not confirmed; refresh the session cookie and try again`
      );
    }
  };

  const artistPath = (artist: string): string => {
    const trimmed = artist.trim().replace(/^_+/, '');
    if (!/^[a-z0-9~._-]{1,50}$/i.test(trimmed)) {
      throw new Error('FurAffinity artist name is invalid');
    }
    return trimmed;
  };

  const readArtistAction = async (
    site: BooruSiteRecord,
    artist: string
  ): Promise<{ action: 'watch' | 'unwatch'; path: string }> => {
    const safeArtist = artistPath(artist);
    const response = await request(
      site,
      `/user/${encodeURIComponent(safeArtist)}/`
    );
    assertNotChallenge(response.body);
    if (!/\bid=["']pageid-userpage["']/i.test(response.body)) {
      throw new FurAffinityPageError(
        'FurAffinity returned an unexpected artist page'
      );
    }
    const match = /href=["']\/(watch|unwatch)\/([^"'?/]+)\/?\?key=([a-z0-9]+)["']/i.exec(
      response.body
    );
    if (!match) {
      throw new Error(
        `${site.name} did not expose a watch action; the session cookie may be expired`
      );
    }
    return {
      action: match[1].toLowerCase() as 'watch' | 'unwatch',
      path: `/${match[1].toLowerCase()}/${match[2]}/?key=${match[3]}`
    };
  };

  const setArtistSubscription = async (
    site: BooruSiteRecord,
    artist: string,
    subscribed: boolean
  ): Promise<void> => {
    requireCredentials(site);
    const before = await readArtistAction(site, artist);
    if (subscribed && before.action === 'unwatch') return;
    if (!subscribed && before.action === 'watch') return;
    await request(site, before.path, { allowRedirect: true });
    const after = await readArtistAction(site, artist);
    const confirmed = subscribed
      ? after.action === 'unwatch'
      : after.action === 'watch';
    if (!confirmed) {
      throw new Error(
        `${site.name} ${subscribed ? 'follow' : 'unfollow'} not confirmed; refresh the session cookie and try again`
      );
    }
  };

  return {
    type: 'furaffinity',
    credentialSchema: 'username+session-cookie',
    supportsSessionCookie: true,
    defaultCapabilities: {
      favorites: true,
      tags: true,
      sourceMatch: true,
      search: true,
      vote: false
    },
    supportedExploreSorts: ['new'],
    supportsExploreTagSearch: false,
    defaultUserAgent: config.e621.userAgent,
    probePath: '/',
    probeMatches: (body: unknown): boolean =>
      typeof body === 'string' &&
      /Fur Affinity \[dot\] net/i.test(body) &&
      /\bid=["']pageid-[^"']+["']/i.test(body),
    probeSample: (body: unknown) => {
      if (typeof body !== 'string') return null;
      const id = listingIds(body)[0];
      if (!id) return null;
      const rawChunk = body
        .split('</figure>')
        .find((part) => new RegExp(`\\bid=["']sid-${id}["']`, 'i').test(part));
      const figureStart = rawChunk?.search(
        new RegExp(`<figure[^>]*\\bid=["']sid-${id}["']`, 'i')
      );
      const chunk =
        rawChunk && figureStart !== undefined && figureStart >= 0
          ? rawChunk.slice(figureStart)
          : null;
      const thumb = chunk
        ? /<img[^>]*\bsrc=["']([^"']+)["']/i.exec(chunk)?.[1] ?? null
        : null;
      return {
        postId: id,
        thumbUrl: normalizeFurAffinityMediaUrl(thumb),
        postPath: `/view/${id}/`
      };
    },

    async fetchPostTags(site, postId): Promise<TagResult[]> {
      requireCredentials(site);
      const page = await readSubmission(site, postId);
      return page.missing ? [] : page.tags;
    },

    async fetchPostDetails(site, postId) {
      requireCredentials(site);
      const page = await readSubmission(site, postId);
      if (page.missing) return null;
      return {
        tags: page.tags,
        relations: { parentId: null, hasChildren: false, poolIds: [] },
        fileUrl: page.fileUrl
      };
    },

    async fetchFavorites(
      site,
      ctx?: FetchFavoritesContext
    ): Promise<{
      items: BooruRemoteFavorite[];
      downloadHeaders: Record<string, string>;
    }> {
      requireCredentials(site);
      const signal = ctx?.signal;
      const postIds: string[] = [];
      const seenPostIds = new Set<string>();
      const seenCursors = new Set<string>();
      let path = `/favorites/${encodeURIComponent(site.username!)}/`;

      for (let page = 1; page <= FA_MAX_FAVORITES_PAGES; page += 1) {
        const response = await request(site, path, { signal });
        assertNotChallenge(response.body);
        if (
          !/\bid=["']pageid-favorites["']/i.test(response.body) ||
          !/\bid=["']gallery-favorites["']/i.test(response.body)
        ) {
          throw new FurAffinityPageError(
            'FurAffinity returned an unexpected favorites page'
          );
        }
        const ids = listingIds(response.body);
        for (const id of ids) {
          if (!seenPostIds.has(id)) {
            seenPostIds.add(id);
            postIds.push(id);
          }
        }
        ctx?.onPage?.(page, ids.length);
        const cursor = nextFavoritesCursor(response.body);
        if (!cursor) break;
        if (seenCursors.has(cursor)) {
          throw new FurAffinityPageError(
            'FurAffinity favorites cursor repeated; sync stopped safely'
          );
        }
        seenCursors.add(cursor);
        path = cursor;
        if (page === FA_MAX_FAVORITES_PAGES) {
          throw new FurAffinityPageError(
            'FurAffinity favorites exceeded the safe pagination limit'
          );
        }
      }

      const items: BooruRemoteFavorite[] = [];
      const downloadHeaders = { 'User-Agent': config.e621.userAgent };
      ctx?.onItem?.(0, postIds.length);
      for (const postId of postIds) {
        if (signal?.aborted) throw abortError();
        let fileUrl: string | null = null;
        try {
          const submissionPage = await readSubmission(site, postId, signal);
          fileUrl = submissionPage.fileUrl;
        } catch (error) {
          if (error instanceof FurAffinityPageError) throw error;
          if (signal?.aborted) throw abortError();
          console.warn(
            `[furaffinity] failed to resolve favorite ${postId}: ${safeErrorMessage(site, error)}`
          );
        }
        const item = {
          provider: site.id,
          remoteId: postId,
          sourceUrl: `${FA_ORIGIN}/view/${postId}/`,
          fileUrl
        };
        items.push(item);
        ctx?.onItem?.(items.length, postIds.length);
        await ctx?.onFavoriteResolved?.(item, downloadHeaders, postIds.length);
      }
      return {
        items,
        downloadHeaders
      };
    },

    favorite: (site, postId) => setFavoriteState(site, postId, true),
    unfavorite: (site, postId) => setFavoriteState(site, postId, false),

    async resolvePostFileUrl(site, postId) {
      requireCredentials(site);
      const page = await readSubmission(site, postId);
      if (page.missing) return null;
      return page.fileUrl;
    },

    async searchPosts(site, options) {
      if (options.sort !== 'new') {
        throw new Error(`${site.name} only supports the New sort in Explore`);
      }
      if (options.tags.length) {
        throw new Error(`${site.name} does not support tag search in Explore`);
      }
      const path = options.page === 1 ? '/browse/' : `/browse/${options.page}/`;
      const response = await request(site, path, { authenticated: false });
      const parsed = parseFurAffinityListingPage(response.body, 'browse');
      return {
        posts: parsed.posts,
        downloadHeaders: { 'User-Agent': config.e621.userAgent }
      };
    },

    async listArtistSubscriptions(site) {
      requireCredentials(site);
      const response = await request(
        site,
        `/watchlist/by/${encodeURIComponent(site.username!)}/`
      );
      return parseFurAffinityWatchlist(response.body, site.username!);
    },

    subscribeArtist: (site, artist) =>
      setArtistSubscription(site, artist, true),
    unsubscribeArtist: (site, artist) =>
      setArtistSubscription(site, artist, false),

    async fetchSubscriptionPosts(site, cursor) {
      requireCredentials(site);
      if (
        cursor !== null &&
        !/^\/msg\/submissions\/new~\d+@48\/$/.test(cursor)
      ) {
        throw new Error('FurAffinity submissions cursor is invalid');
      }
      const response = await request(site, cursor ?? '/msg/submissions/');
      const parsed = parseFurAffinityListingPage(
        response.body,
        'subscriptions'
      );
      if (cursor !== null && parsed.nextCursor === cursor) {
        throw new Error('FurAffinity submissions cursor loop detected');
      }
      return {
        ...parsed,
        downloadHeaders: { 'User-Agent': config.e621.userAgent }
      };
    },

    async checkSessionCookie(site) {
      if (!site.sessionCookie) {
        return { ok: false, error: 'no session cookie saved' };
      }
      try {
        const browse = await request(site, '/browse/');
        assertNotChallenge(browse.body);
        if (!/\bid=["']pageid-browse["']/i.test(browse.body)) {
          return { ok: false, error: 'FurAffinity returned an unexpected browse page' };
        }
        const sampleId = listingIds(browse.body)[0];
        if (!sampleId) {
          return { ok: false, error: 'FurAffinity browse page had no sample submission' };
        }
        const sample = await readSubmission(site, sampleId);
        if (sample.action && sample.actionPath) return { ok: true };
        return {
          ok: false,
          error: 'not authenticated; the session cookie may be expired or incomplete'
        };
      } catch (error) {
        return {
          ok: false,
          error: `cookie check failed: ${safeErrorMessage(site, error)}`
        };
      }
    },

    extractIdFromUrl(url) {
      try {
        const parsed = new URL(url);
        if (!/^(?:www\.|sfw\.)?furaffinity\.net$/i.test(parsed.hostname)) {
          return null;
        }
        const match = /^\/(?:view|full)\/(\d+)\/?$/i.exec(parsed.pathname);
        return match ? { remoteId: match[1] } : null;
      } catch {
        return null;
      }
    },

    buildPostUrl(_site, postId) {
      return `${FA_ORIGIN}/view/${postId}/`;
    }
  };
};

export const furaffinityEngine = createFurAffinityEngine();
