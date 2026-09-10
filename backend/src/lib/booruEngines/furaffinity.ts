import { config } from '../../config';
import type { BooruSiteRecord } from '../../db/types';

import {
  assertNotChallenge,
  FurAffinityPageError,
  listingIds,
  nextFavoritesCursor,
  normalizeFurAffinityMediaUrl,
  parseFurAffinityListingPage,
  parseFurAffinityWatchlist
} from './furaffinityHtml';
import {
  createFurAffinityRequester,
  type FurAffinityRequestOptions,
  requireFurAffinityCredentials,
  safeFurAffinityError
} from './furaffinityRequest';
import type {
  BooruEngineModule,
  BooruRemoteFavorite,
  FetchFavoritesContext,
  TagResult
} from './types';

const FA_ORIGIN = 'https://www.furaffinity.net';
const FA_MAX_FAVORITES_PAGES = 1_000;
type FurAffinityEngineOptions = FurAffinityRequestOptions;

export const createFurAffinityEngine = (
  options: FurAffinityEngineOptions = {}
): BooruEngineModule => {
  const { request, readSubmission, abortError } =
    createFurAffinityRequester(FA_ORIGIN, options);

  const setFavoriteState = async (
    site: BooruSiteRecord,
    postId: string,
    favorited: boolean
  ): Promise<void> => {
    requireFurAffinityCredentials(site);
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
    requireFurAffinityCredentials(site);
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
      requireFurAffinityCredentials(site);
      const page = await readSubmission(site, postId);
      return page.missing ? [] : page.tags;
    },

    async fetchPostDetails(site, postId) {
      requireFurAffinityCredentials(site);
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
      requireFurAffinityCredentials(site);
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
            `[furaffinity] failed to resolve favorite ${postId}: ${safeFurAffinityError(site, error)}`
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
      requireFurAffinityCredentials(site);
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
      requireFurAffinityCredentials(site);
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
      requireFurAffinityCredentials(site);
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
          error: `cookie check failed: ${safeFurAffinityError(site, error)}`
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
