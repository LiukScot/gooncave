import { useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  automaticDuplicateFavoriteTargets,
  drainAutomaticFavoriteQueue,
  type AutomaticFavoriteQueueItem
} from './automaticDuplicateFavorites';
import { shouldAutoVote } from './autoVote';
import {
  exploreReturnScrollY,
  readExploreQuery,
  readExploreSnapshot,
  writeExploreSnapshot
} from './exploreSnapshot';
import {
  fillPages,
  openStreams,
  pageLimitForMerge,
  type FillOptions,
  type FillResult,
  type MergeSort,
  type SiteStream
} from './mergeStream';
import { explorePostKey } from './navSequence';
import { shiftAnchor, todayIso } from './popularPeriod';
import {
  collectSubscriptionPosts,
  loadSubscriptionPosts,
  searchSortForTag
} from './subscriptionFeed';
import { useExploreSequence } from './useExploreSequence';
import { useTagSubscriptionAction } from './useTagSubscriptionAction';
import { withVisualMatches } from './visualMatch';
import { voteDelta } from './voteDelta';

import {
  api,
  type BooruSite,
  type ExplorePost,
  type ExploreSiteError,
  type ExploreSort,
  type ExploreWindow
} from '@/api';
import { useChoose } from '@/components/confirm-dialog';
import { listenToUserScroll } from '@/features/file-detail/listenToUserScroll';
import { restoreScrollTo } from '@/features/file-detail/restoreScrollTo';
import { useDetailScrollRestore } from '@/features/file-detail/useDetailScrollRestore';
import { appendTagTerm } from '@/features/library/tagInputTokens';
import { flushReadQueue, queueRead, queueReads } from '@/features/read-marks/readQueue';
import {
  readUnreadOnly,
  writeUnreadOnly
} from '@/features/read-marks/unreadOnly';
import {
  effectiveBlacklist,
  isBlacklisted
} from '@/features/settings/blacklist';
import { getDetailUrlSyncAction } from '@/features/shell/galleryDetailSync';
import { useBooruEngineCatalog, useBooruSites } from '@/hooks/booru-sites';
import { useDuplicateSettings } from '@/hooks/duplicates';
import {
  useBlacklistSettings,
  useExtraSettings,
  useSubscriptionTags
} from '@/hooks/settings';
import { useExploreUiStore } from '@/stores/exploreUiStore';

const PAGE_SIZE = 40;
/**
 * How many pages one Load more may ask for. Sites ranked within a point of
 * each other release a post at a time; without a cap a search could keep
 * fetching, with one it costs at most this many requests.
 */
const MAX_FILL_ROUNDS = 5;
const FAVORITE_SETTLE_MS = 150;

export type ExploreSiteOption = BooruSite & {
  /** The engine has a vote API at all. */
  supportsVote: boolean;
  /** …and this account can actually use it. */
  canVote: boolean;
  /** The booru takes favorites and this account has the key to send one. */
  canFavorite: boolean;
  supportedExploreSorts: Array<'new' | 'hot' | 'popular'>;
  supportsExploreTagSearch: boolean;
};

const credentialsReady = (site: BooruSite): boolean => {
  switch (site.engineCredentialSchema) {
    case 'username+apikey':
    case 'userid+apikey':
      return Boolean(site.username) && site.hasApiKey;
    case 'username+session-cookie':
      return Boolean(site.username) && site.hasSessionCookie;
    case 'apikey-only':
    case 'token':
      return site.hasApiKey;
    case 'none':
      return true;
  }
};

export { explorePostKey };

export function useExploreController({
  onLibraryChange
}: {
  onLibraryChange?: () => void | Promise<void>;
} = {}) {
  const sitesQuery = useBooruSites();
  const catalogQuery = useBooruEngineCatalog();
  const choose = useChoose();
  const blacklist = useBlacklistSettings();
  const duplicateSettings = useDuplicateSettings();
  const {
    autoVoteOnFavorite,
    exploreStackDuplicates,
    galleryUnreadOnlyEnabled,
    loaded: extraSettingsLoaded
  } = useExtraSettings();
  const readTrackingEnabled = extraSettingsLoaded && galleryUnreadOnlyEnabled;

  /**
   * The search the reader left behind, resumed here rather than after the
   * first render: the snapshot's results are only used when they answer the
   * search on screen, so the search has to be right before anything asks.
   */
  const resumed = readExploreQuery();
  const [tagInput, setTagInput] = useState(resumed?.tagInput ?? '');
  const [tagQuery, setTagQuery] = useState(resumed?.tagQuery ?? '');
  const [sort, setSort] = useState<ExploreSort>(resumed?.sort ?? 'new');
  const [popularWindow, setPopularWindow] = useState<ExploreWindow>(
    resumed?.popularWindow ?? 'day'
  );
  /** Any date inside the period shown; the backend widens it to the period. */
  const [popularDate, setPopularDate] = useState<string>(
    () => resumed?.popularDate ?? todayIso()
  );
  const [disabledSiteIds, setDisabledSiteIds] = useState<Set<string>>(
    () => new Set(resumed?.disabledSiteIds ?? [])
  );
  /**
   * Hide posts already shown. Kept in this component rather than the snapshot
   * because it is a lasting preference, not part of one search.
   */
  const [unreadOnly, setUnreadOnly] = useState(() => readUnreadOnly('explore'));
  const effectiveUnreadOnly = readTrackingEnabled && unreadOnly;
  /**
   * Whether this search actually dropped anything as read. Without it an empty
   * result would claim the reader had finished a search that simply found
   * nothing. Counted in a ref by the filter and published after each fill, so
   * the predicate stays a predicate.
   */
  const readHiddenCountRef = useRef(0);
  const [readHidden, setReadHidden] = useState(false);
  const [isSiteFilterOpen, setIsSiteFilterOpen] = useState(false);
  const siteFilterRef = useRef<HTMLDivElement | null>(null);
  const subscriptionTags = useSubscriptionTags();
  const {
    actionFor: subscriptionActionFor,
    blacklistActionFor,
    runAction: runSubscriptionAction
  } = useTagSubscriptionAction();

  const searchableSites: ExploreSiteOption[] = useMemo(() => {
    const catalogByType = new Map(
      (catalogQuery.data?.engines ?? []).map((engine) => [engine.type, engine])
    );
    return (sitesQuery.data ?? [])
      .filter((site) => {
        const engine = catalogByType.get(site.engine);
        if (!site.enabled || !engine?.defaultCapabilities.search) return false;
        if (sort === 'subscribed') return true;
        if (!engine.supportedExploreSorts.includes(sort)) return false;
        return !tagQuery.trim() || engine.supportsExploreTagSearch;
      })
      .map((site) => {
        const engine = catalogByType.get(site.engine)!;
        return {
          ...site,
          supportsVote: engine.defaultCapabilities.vote,
          canVote: engine.defaultCapabilities.vote && credentialsReady(site),
          canFavorite:
            engine.defaultCapabilities.favorites && credentialsReady(site),
          supportedExploreSorts: engine.supportedExploreSorts,
          supportsExploreTagSearch: engine.supportsExploreTagSearch
        };
      });
  }, [sitesQuery.data, catalogQuery.data, sort, tagQuery]);

  const [posts, setPosts] = useState<ExplorePost[]>([]);
  const [siteErrors, setSiteErrors] = useState<ExploreSiteError[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const [selectedPost, setSelectedPost] = useState<ExplorePost | null>(null);
  const poolContext = useExploreUiStore((state) => state.poolContext);
  const setPoolContext = useExploreUiStore((state) => state.setPoolContext);
  /**
   * Favorites added or removed in this session, keyed by post. The server
   * marks what it already knew about, so this only has to cover the gap
   * between a click and the next fetch — which is why it is never cleared
   * when results reload, and why it has to be able to say `false`: a post
   * the server still believes is favorited has just been un-favorited here.
   */
  const [favoriteOverrides, setFavoriteOverrides] = useState<
    Map<string, boolean>
  >(() => new Map());

  const isFavorited = useCallback(
    (post: ExplorePost) =>
      favoriteOverrides.get(explorePostKey(post)) ?? post.favorited,
    [favoriteOverrides]
  );

  const [votedKeys, setVotedKeys] = useState<Map<string, 1 | -1 | null>>(
    () => new Map()
  );

  /**
   * The vote to paint on the buttons: this session's click if there was one,
   * otherwise whatever the booru says the account already cast. A booru that
   * reports nothing leaves the buttons uncoloured rather than claiming the
   * post was never voted on.
   */
  const voteOf = useCallback(
    (post: ExplorePost): 1 | -1 | null => {
      const local = votedKeys.get(explorePostKey(post));
      if (local !== undefined) return local;
      return post.voted === 1 || post.voted === -1 ? post.voted : null;
    },
    [votedKeys]
  );

  const [actionError, setActionError] = useState<string | null>(null);
  // Two keys, not one: favoriting downloads the file and takes seconds, and
  // a single flag made it disable the vote buttons for that whole time.
  const [pendingVoteKey, setPendingVoteKey] = useState<string | null>(null);
  const [pendingFavoriteKey, setPendingFavoriteKey] = useState<string | null>(
    null
  );
  const favoriteDesiredRef = useRef(new Map<string, boolean>());
  const favoriteWorkersRef = useRef(new Map<string, Promise<void>>());
  const automaticFavoriteAttemptsRef = useRef(new Set<string>());
  const automaticFavoriteQueueRef = useRef<AutomaticFavoriteQueueItem[]>([]);
  const automaticFavoriteWorkerRef = useRef<Promise<void> | null>(null);
  const automaticFavoriteGenerationRef = useRef(0);
  const deferredFavoriteVoteRef = useRef(new Map<string, 1 | -1 | null>());

  useEffect(
    () => () => {
      automaticFavoriteGenerationRef.current += 1;
      automaticFavoriteQueueRef.current.length = 0;
    },
    []
  );

  const subscribedTags = useMemo(
    () => subscriptionTags.data?.tags ?? [],
    [subscriptionTags.data?.tags]
  );
  const subscribedArtistSiteIds = useMemo(
    () =>
      new Set(
        searchableSites
          .filter(
            (site) =>
              site.engine === 'furaffinity' && credentialsReady(site)
          )
          .map((site) => site.id)
      ),
    [searchableSites]
  );
  const hasSubscriptions =
    subscribedTags.length > 0 || subscribedArtistSiteIds.size > 0;
  const activeSiteIds = useMemo(
    () =>
      searchableSites
        .filter((site) => !disabledSiteIds.has(site.id))
        .filter((site) => {
          if (sort !== 'subscribed') return true;
          if (site.engine === 'furaffinity') {
            return subscribedArtistSiteIds.has(site.id);
          }
          return subscribedTags.length > 0;
        })
        .map((site) => site.id),
    [
      searchableSites,
      disabledSiteIds,
      sort,
      subscribedArtistSiteIds,
      subscribedTags.length
    ]
  );
  const activeSiteKey = activeSiteIds.join(',');
  const sitesReady =
    sitesQuery.isSuccess &&
    catalogQuery.isSuccess &&
    blacklist.loaded &&
    duplicateSettings.isFetched &&
    (sort !== 'subscribed' || subscriptionTags.isSuccess);

  /**
   * Blacklisted tags for the search on screen. Explore filters on the client
   * because the results already carry their tags, and because the boorus cap
   * how many terms one query may hold.
   */
  const hiddenTags = useMemo(
    () =>
      new Set(
        blacklist.applyToExplore
          ? effectiveBlacklist(blacklist.tags, tagQuery)
          : []
      ),
    [blacklist.applyToExplore, blacklist.tags, tagQuery]
  );

  const siteById = useMemo(
    () => new Map(searchableSites.map((site) => [site.id, site])),
    [searchableSites]
  );

  const requestRef = useRef<AbortController | null>(null);
  /** Where each site has got to in the merged ranking. */
  const streamsRef = useRef<Map<string, SiteStream>>(new Map());
  const subscriptionCursorRef = useRef<string | null>(null);
  /** Buffered or already shown, so no site contributes the same post twice. */
  const seenRef = useRef({ keys: new Set<string>() });

  const mergeSort: MergeSort = sort === 'subscribed' ? 'new' : sort;
  const remotePageLimit = pageLimitForMerge(
    mergeSort,
    PAGE_SIZE,
    activeSiteIds.length
  );

  /**
   * Whether a post joins the buffer — and, as a side effect, the record that
   * it was offered. Every sort drops repeats of one site's post while keeping
   * copies from different sites.
   */
  const keepPost = useCallback(
    (post: ExplorePost) => {
      const key = explorePostKey(post);
      const seen = seenRef.current;
      if (seen.keys.has(key)) return false;
      seen.keys.add(key);
      // Recorded as offered either way, so a post dropped here cannot come
      // back from another site's page or a later one.
      if (effectiveUnreadOnly && post.read) {
        readHiddenCountRef.current += 1;
        return false;
      }
      return !isBlacklisted(post.tags, hiddenTags);
    },
    [effectiveUnreadOnly, hiddenTags]
  );

  const fetchSubscriptionPage = useCallback(
    (cursor: string | null, signal: AbortSignal) =>
      collectSubscriptionPosts({
        cursor,
        target: PAGE_SIZE,
        signal,
        fetchPage: (nextCursor) =>
          api.exploreSubscriptions({
            siteIds: activeSiteIds,
            cursor: nextCursor ?? undefined,
            limit: PAGE_SIZE,
            signal
          }),
        keep: keepPost
      }),
    [activeSiteIds, keepPost]
  );

  const fillOptions = useCallback(
    (signal: AbortSignal): FillOptions => ({
      sort: mergeSort,
      limit: remotePageLimit,
      target: PAGE_SIZE,
      maxRounds: MAX_FILL_ROUNDS,
      keep: keepPost,
      signal,
      // A site error travels back as a rejection: to the merge, a site that
      // cannot answer and one that has run out are the same thing.
      fetchPage: async (siteId, page, requestSignal) => {
        const data = await api.explorePosts({
          tags: tagQuery.split(/[\s,]+/).filter(Boolean),
          sort: mergeSort,
          window: popularWindow,
          date: popularWindow === 'all' ? undefined : popularDate,
          siteIds: [siteId],
          page,
          limit: remotePageLimit,
          signal: requestSignal
        });
        if (data.siteErrors.length) throw new Error(data.siteErrors[0].error);
        return data.posts;
      }
    }),
    [keepPost, mergeSort, popularDate, popularWindow, remotePageLimit, tagQuery]
  );

  const favoriteEveryMatchedCopy =
    duplicateSettings.data?.enabled === true &&
    duplicateSettings.data.style === 'favorite_all';
  const preparePosts = useCallback(
    (next: ExplorePost[], signal: AbortSignal) =>
      exploreStackDuplicates || favoriteEveryMatchedCopy
        ? withVisualMatches(next, signal)
        : Promise.resolve(next),
    [exploreStackDuplicates, favoriteEveryMatchedCopy]
  );

  const applyResult = useCallback(
    (result: FillResult, preparedPosts: ExplorePost[]) => {
      streamsRef.current = result.streams;
      setPosts((prev) => [...prev, ...preparedPosts]);
      setSiteErrors((prev) => [
        ...prev,
        ...result.errors.map(({ siteId, error }) => ({
          siteId,
          siteName: siteById.get(siteId)?.name ?? siteId,
          error
        }))
      ]);
      setHasMore(result.hasMore);
      setReadHidden(readHiddenCountRef.current > 0);
    },
    [siteById]
  );

  const reload = useCallback(async () => {
    // A newer search must win: the old one is aborted rather than left to
    // land late and overwrite the list the user is now looking at.
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    streamsRef.current = new Map();
    subscriptionCursorRef.current = null;
    seenRef.current = { keys: new Set() };
    automaticFavoriteGenerationRef.current += 1;
    automaticFavoriteAttemptsRef.current.clear();
    automaticFavoriteQueueRef.current.length = 0;
    readHiddenCountRef.current = 0;
    setReadHidden(false);
    setPosts([]);
    setSiteErrors([]);
    setHasMore(false);
    if (!activeSiteIds.length) {
      setLoading(false);
      return;
    }
    setLoading(true);
    // Same reason as the gallery: the server filters on marks it has been
    // told about, so a search started seconds after a scroll has to wait for
    // them. A no-op when nothing is queued.
    if (effectiveUnreadOnly) await flushReadQueue();
    if (sort === 'subscribed') {
      const first = await loadSubscriptionPosts({
        cursor: null,
        target: PAGE_SIZE,
        signal: controller.signal,
        refresh: api.refreshExploreSubscriptions,
        fetchPage: (cursor) =>
          api.exploreSubscriptions({
            siteIds: activeSiteIds,
            cursor: cursor ?? undefined,
            limit: PAGE_SIZE,
            signal: controller.signal
          }),
        keep: keepPost
      });
      if (controller.signal.aborted) return;
      subscriptionCursorRef.current = first.nextCursor;
      const prepared = await preparePosts(first.posts, controller.signal);
      if (controller.signal.aborted) return;
      setPosts(prepared);
      setSiteErrors(
        first.refreshError instanceof Error
          ? [
              {
                siteId: 'subscriptions',
                siteName: 'Subscriptions',
                error: first.refreshError.message
              }
            ]
          : (first.refreshed?.errors ?? [])
      );
      setHasMore(first.hasMore);
      setLoading(false);
      if (first.refreshed === null && first.refreshError === null) {
        void api
          .refreshExploreSubscriptions()
          .then((result) => {
            if (!controller.signal.aborted) setSiteErrors(result.errors);
          })
          .catch((error: Error) => {
            if (!controller.signal.aborted) {
              setSiteErrors([
                {
                  siteId: 'subscriptions',
                  siteName: 'Subscriptions',
                  error: error.message
                }
              ]);
            }
          });
      }
      return;
    }
    const result = await openStreams(
      activeSiteIds,
      fillOptions(controller.signal)
    );
    if (controller.signal.aborted) return;
    const prepared = await preparePosts(result.posts, controller.signal);
    if (controller.signal.aborted) return;
    applyResult(result, prepared);
    setLoading(false);
  }, [
    activeSiteIds,
    applyResult,
    fillOptions,
    keepPost,
    preparePosts,
    sort,
    effectiveUnreadOnly
  ]);

  /** Identity of the search on screen — exactly what a reload depends on. */
  const searchKey = [
    tagQuery,
    sort,
    popularWindow,
    popularDate,
    activeSiteKey,
    effectiveUnreadOnly ? 'unread' : 'all',
    exploreStackDuplicates ? 'stacked' : 'separate',
    favoriteEveryMatchedCopy ? 'favorite-matches' : 'leave-matches'
  ].join('\u0000');

  // Wait for the site list and the blacklist before the first fetch: without
  // the sites it would search none, without the blacklist it would show what
  // the blacklist is there to hide.
  //
  // The reader coming back from another page is served from the snapshot
  // instead: same posts, same place in them, and Load more carrying on from
  // where it stopped rather than from page one. Only the search this mount
  // opened on is restorable — changing the search is always a real reload.
  //
  // Keyed by search rather than by a "first run" flag: StrictMode runs every
  // effect twice in development, and a flag the first pass consumed left the
  // second one reloading over the results it had just restored.
  const servedKeyRef = useRef<string | null>(null);
  const [restoredScrollY, setRestoredScrollY] = useState<number | null>(null);
  useEffect(() => {
    if (!sitesReady) return;
    if (servedKeyRef.current === searchKey) return;
    const snapshot =
      servedKeyRef.current === null ? readExploreSnapshot(searchKey) : null;
    servedKeyRef.current = searchKey;
    if (snapshot) {
      // Load more needs a live controller, and this mount has none yet.
      requestRef.current = new AbortController();
      streamsRef.current = snapshot.streams;
      subscriptionCursorRef.current = snapshot.subscriptionCursor;
      seenRef.current = snapshot.seen;
      setPosts(snapshot.posts);
      setSiteErrors(snapshot.siteErrors);
      setHasMore(snapshot.hasMore);
      setLoading(false);
      gridScrollRef.current = snapshot.scrollY;
      setRestoredScrollY(snapshot.scrollY);
      return;
    }
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sitesReady,
    tagQuery,
    sort,
    popularWindow,
    popularDate,
    activeSiteKey,
    effectiveUnreadOnly,
    exploreStackDuplicates,
    favoriteEveryMatchedCopy
  ]);

  // Its own effect so that re-running it is harmless: cancelling and
  // restarting the attempt lands in the same place, where a restore tied to
  // the effect above would simply be cancelled by StrictMode's second pass.
  useEffect(() => {
    if (restoredScrollY === null) return;
    return restoreScrollTo(restoredScrollY);
  }, [restoredScrollY]);

  // Where the grid was left. Read at unmount, when the window is already
  // showing whatever page the reader moved to, so it cannot be read then.
  const gridScrollRef = useRef(0);
  const openedFromGridScrollRef = useRef<number | null>(null);
  // Kept in a ref because the unmount cleanup below would otherwise close
  // over whatever these were on first render.
  const query = {
    tagInput,
    tagQuery,
    sort,
    popularWindow,
    popularDate,
    disabledSiteIds: [...disabledSiteIds]
  };
  const latestRef = useRef({
    searchKey,
    query,
    posts,
    siteErrors,
    hasMore,
    selectedPost
  });
  latestRef.current = { searchKey, query, posts, siteErrors, hasMore, selectedPost };

  useEffect(
    () => () => {
      requestRef.current?.abort();
      // The search this mount served is forgotten along with the request, so
      // that StrictMode's simulated remount runs it again rather than
      // skipping it and leaving the view loading a request it just aborted.
      servedKeyRef.current = null;
      const latest = latestRef.current;
      // An empty list is not worth coming back to, and would only stop the
      // next visit from searching.
      if (!latest.posts.length) return;
      writeExploreSnapshot({
        key: latest.searchKey,
        query: latest.query,
        posts: latest.posts,
        siteErrors: latest.siteErrors,
        hasMore: latest.hasMore,
        streams: streamsRef.current,
        subscriptionCursor: subscriptionCursorRef.current,
        seen: seenRef.current,
        scrollY: exploreReturnScrollY(
          gridScrollRef.current,
          openedFromGridScrollRef.current,
          latest.selectedPost !== null
        )
      });
    },
    []
  );

  const loadMore = useCallback(async (): Promise<ExplorePost[]> => {
    if (loading) return [];
    // Makes its own controller when there is no live one. There isn't after
    // results were restored from the snapshot, and there isn't in
    // development, where StrictMode runs the unmount cleanup — which aborts
    // it — once before the view has really settled. A click here is proof
    // the view is mounted, so a fresh controller is always the right answer.
    let controller = requestRef.current;
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      requestRef.current = controller;
    }
    setLoading(true);
    try {
      if (!(await flushReadQueue('post'))) {
        throw new Error('Could not mark the loaded posts as read. Try again.');
      }
      if (sort === 'subscribed') {
        const result = await fetchSubscriptionPage(
          subscriptionCursorRef.current,
          controller.signal
        );
        if (controller.signal.aborted) return [];
        subscriptionCursorRef.current = result.nextCursor;
        const prepared = await preparePosts(result.posts, controller.signal);
        if (controller.signal.aborted) return [];
        setPosts((current) => [...current, ...prepared]);
        setHasMore(result.hasMore);
        return result.posts;
      }
      const result = await fillPages(
        streamsRef.current,
        fillOptions(controller.signal)
      );
      if (controller.signal.aborted) return [];
      const prepared = await preparePosts(result.posts, controller.signal);
      if (controller.signal.aborted) return [];
      applyResult(result, prepared);
      return result.posts;
    } catch (error) {
      if (!controller.signal.aborted) {
        setSiteErrors((current) => [
          ...current,
          {
            siteId: 'load-more',
            siteName: sort === 'subscribed' ? 'Subscriptions' : 'Explore',
            error: error instanceof Error ? error.message : String(error)
          }
        ]);
      }
      return [];
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [applyResult, fetchSubscriptionPage, fillOptions, loading, preparePosts, sort]);

  const submitSearch = useCallback(() => setTagQuery(tagInput.trim()), [tagInput]);

  // Remote search is costlier than the local gallery query, but it should
  // still behave like the same control. Abort handling in reload ensures a
  // slower older search cannot replace a newer one.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setTagQuery(tagInput.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [tagInput]);

  /**
   * Runs the explore search off a tag pill. Same two actions as the gallery,
   * with the same meaning: Search adds the tag to what is already in the box
   * rather than replacing it (issue #307).
   */
  const selectTag = useCallback(
    async (tag: string) => {
      const mode = await choose('', {
        title: tag,
        actions: [
          { value: 'search', label: 'Search tag' },
          subscriptionActionFor(tag),
          blacklistActionFor(tag)
        ]
      });
      if (!mode) return;
      if (mode !== 'search') {
        await runSubscriptionAction(mode, tag);
        return;
      }
      const next = appendTagTerm(tagInput, tag);
      setTagInput(next);
      setTagQuery(next);
      setSort(searchSortForTag(sort));
      setSelectedPost(null);
    },
    [blacklistActionFor, choose, runSubscriptionAction, sort, subscriptionActionFor, tagInput]
  );

  // Switching scale keeps the date the user is looking at, so going from a
  // day to its week shows the week that day belongs to.
  const stepPeriod = useCallback(
    (direction: -1 | 1) =>
      setPopularDate((current) =>
        shiftAnchor(popularWindow, current, direction)
      ),
    [popularWindow]
  );

  const toggleSite = useCallback((siteId: string) => {
    setDisabledSiteIds((prev) => {
      const next = new Set(prev);
      if (next.has(siteId)) next.delete(siteId);
      else next.add(siteId);
      return next;
    });
  }, []);

  const votePost = useCallback(
    async (post: ExplorePost, score: 1 | -1) => {
      const key = explorePostKey(post);
      const previousVote = voteOf(post);
      const nextVote = previousVote === score ? null : score;
      const delta = voteDelta(previousVote, nextVote ?? 0);
      const applyDelta = (amount: number) => {
        if (amount === 0) return;
        const patch = (target: ExplorePost): ExplorePost =>
          target.score === null
            ? target
            : { ...target, score: target.score + amount };
        setPosts((current) => current.map((entry) =>
          explorePostKey(entry) === key ? patch(entry) : entry
        ));
        setSelectedPost((current) =>
          current && explorePostKey(current) === key ? patch(current) : current
        );
      };
      setActionError(null);
      setVotedKeys((current) => new Map(current).set(key, nextVote));
      applyDelta(delta);
      if (favoriteWorkersRef.current.has(key)) {
        deferredFavoriteVoteRef.current.set(key, nextVote);
        return;
      }
      setPendingVoteKey(key);
      try {
        await api.exploreVote({
          siteId: post.siteId,
          remoteId: post.remoteId,
          score: nextVote ?? 0,
          previousScore: nextVote === null ? previousVote ?? undefined : undefined
        });
      } catch (err) {
        setVotedKeys((current) => new Map(current).set(key, previousVote));
        applyDelta(-delta);
        setActionError(`${post.siteName}: ${(err as Error).message}`);
      } finally {
        setPendingVoteKey(null);
      }
    },
    [voteOf]
  );

  /**
   * Adds or drops the favorite, whichever the post is not already.
   *
   * The heart flips before the request answers: favoriting downloads the
   * file on the server and takes seconds, and a button that does nothing
   * visible for that long reads as broken. A failure puts it back and says
   * why.
   */
  const toggleFavorite = useCallback(
    async (post: ExplorePost, favorited: boolean) => {
      const key = explorePostKey(post);
      const desired = !favorited;
      favoriteDesiredRef.current.set(key, desired);
      setFavoriteOverrides((current) => new Map(current).set(key, desired));

      // Every click updates the desired state above. One worker serializes the
      // slow writes and re-checks that state after each response, collapsing
      // any number of rapid clicks into at most the calls needed to reach the
      // final choice.
      if (favoriteWorkersRef.current.has(key)) return;

      const previousVote = voteOf(post);
      const optimisticAutoVote = desired && shouldAutoVote(
        autoVoteOnFavorite,
        siteById.get(post.siteId)?.canVote ?? false,
        previousVote
      );
      const optimisticVoteDelta = optimisticAutoVote
        ? voteDelta(previousVote, 1)
        : 0;
      const applyScoreDelta = (delta: number) => {
        if (delta === 0) return;
        const patch = (target: ExplorePost): ExplorePost =>
          target.score === null
            ? target
            : { ...target, score: target.score + delta };
        setPosts((current) => current.map((entry) =>
          explorePostKey(entry) === key ? patch(entry) : entry
        ));
        setSelectedPost((current) =>
          current && explorePostKey(current) === key ? patch(current) : current
        );
      };
      let autoVoteRolledBack = false;
      const rollbackAutoVote = () => {
        if (!optimisticAutoVote || autoVoteRolledBack) return;
        autoVoteRolledBack = true;
        setVotedKeys((current) => {
          const next = new Map(current);
          if (previousVote === null) next.delete(key);
          else next.set(key, previousVote);
          return next;
        });
        applyScoreDelta(-optimisticVoteDelta);
      };
      setActionError(null);
      setPendingFavoriteKey(key);
      if (optimisticAutoVote) {
        setVotedKeys((current) => new Map(current).set(key, 1));
        applyScoreDelta(optimisticVoteDelta);
      }
      const worker = (async () => {
        let actual = favorited;
        let favoriteWasSent = false;
        let remoteVote = previousVote;
        try {
          while (true) {
            if (actual !== favoriteDesiredRef.current.get(key)) {
              await new Promise((resolve) =>
                globalThis.setTimeout(resolve, FAVORITE_SETTLE_MS)
              );
              if (actual === favoriteDesiredRef.current.get(key)) continue;
              const target = favoriteDesiredRef.current.get(key)!;
              if (target) {
                favoriteWasSent = true;
                const favoriteResult = await api.exploreFavorite({
                  siteId: post.siteId,
                  remoteId: post.remoteId,
                  fileUrl: post.fileUrl ?? undefined,
                  autoVote: optimisticAutoVote
                });
                actual = true;
                if (optimisticAutoVote) {
                  remoteVote = favoriteResult.voteError ? previousVote : 1;
                  if (
                    favoriteResult.voteError &&
                    !deferredFavoriteVoteRef.current.has(key)
                  ) {
                    rollbackAutoVote();
                    setActionError(`${post.siteName}: ${favoriteResult.voteError}`);
                  }
                }
              } else {
                await api.exploreUnfavorite({
                  siteId: post.siteId,
                  remoteId: post.remoteId
                });
                actual = false;
              }
              void onLibraryChange?.();
              continue;
            }

            if (deferredFavoriteVoteRef.current.has(key)) {
              const desiredVote = deferredFavoriteVoteRef.current.get(key)!;
              if (desiredVote === remoteVote) break;
              try {
                await api.exploreVote({
                  siteId: post.siteId,
                  remoteId: post.remoteId,
                  score: desiredVote ?? 0,
                  previousScore:
                    desiredVote === null ? remoteVote ?? undefined : undefined
                });
                remoteVote = desiredVote;
                continue;
              } catch (error) {
                setVotedKeys((current) =>
                  new Map(current).set(key, remoteVote)
                );
                applyScoreDelta(voteDelta(desiredVote, remoteVote ?? 0));
                setActionError(`${post.siteName}: ${(error as Error).message}`);
                deferredFavoriteVoteRef.current.delete(key);
              }
            }
            break;
          }
        } catch (err) {
          favoriteDesiredRef.current.set(key, actual);
          setFavoriteOverrides((current) => new Map(current).set(key, actual));
          rollbackAutoVote();
          setActionError(`${post.siteName}: ${(err as Error).message}`);
        } finally {
          if (optimisticAutoVote && !favoriteWasSent && !actual) {
            rollbackAutoVote();
          }
          favoriteWorkersRef.current.delete(key);
          deferredFavoriteVoteRef.current.delete(key);
          setPendingFavoriteKey((current) => current === key ? null : current);
        }
      })();
      favoriteWorkersRef.current.set(key, worker);
      await worker;
    },
    [autoVoteOnFavorite, onLibraryChange, siteById, voteOf]
  );

  useEffect(() => {
    if (!favoriteEveryMatchedCopy) {
      automaticFavoriteGenerationRef.current += 1;
      automaticFavoriteQueueRef.current.length = 0;
      return;
    }
    const targets = automaticDuplicateFavoriteTargets(
      posts,
      isFavorited,
      (post) => siteById.get(post.siteId)?.canFavorite ?? false
    ).filter(
      (post) => !automaticFavoriteAttemptsRef.current.has(explorePostKey(post))
    );
    if (!targets.length) return;

    const generation = automaticFavoriteGenerationRef.current;
    for (const post of targets) {
      automaticFavoriteAttemptsRef.current.add(explorePostKey(post));
      automaticFavoriteQueueRef.current.push({ generation, post });
    }
    if (automaticFavoriteWorkerRef.current) return;
    const worker = drainAutomaticFavoriteQueue(
      automaticFavoriteQueueRef.current,
      () => automaticFavoriteGenerationRef.current,
      (post) => toggleFavorite(post, false)
    ).finally(() => {
      if (automaticFavoriteWorkerRef.current === worker) {
        automaticFavoriteWorkerRef.current = null;
      }
    });
    automaticFavoriteWorkerRef.current = worker;
  }, [favoriteEveryMatchedCopy, isFavorited, posts, siteById, toggleFavorite]);

  const rememberGridScroll = useDetailScrollRestore(
    selectedPost ? explorePostKey(selectedPost) : null
  );
  const updateReturnAnchor = useCallback(
    (post: ExplorePost) => rememberGridScroll(explorePostKey(post), true),
    [rememberGridScroll]
  );

  const {
    navKeys,
    anchorIndex,
    stepTo,
    goRelative: sequenceGoRelative,
    neighbourAt
  } =
    useExploreSequence({
      posts,
      poolContext,
      setPoolContext,
      selectedPost,
      setSelectedPost,
      onStep: updateReturnAnchor,
      hasMore,
      loadMore
    });

  const toggleUnreadOnly = useCallback(() => {
    if (!readTrackingEnabled) return;
    setUnreadOnly((previous) => {
      writeUnreadOnly('explore', !previous);
      return !previous;
    });
  }, [readTrackingEnabled]);

  const markLoadedRead = useCallback(() => {
    if (!readTrackingEnabled) return;
    queueReads('post', posts.map(explorePostKey));
    setPosts([]);
    setReadHidden(true);
  }, [posts, readTrackingEnabled]);

  // Looking at a post counts as reading it even while the filter is off. The
  // selection catches deep links, back, arrows and swipes, not only card clicks.
  const selectedPostKey = selectedPost ? explorePostKey(selectedPost) : null;
  useEffect(() => {
    if (!readTrackingEnabled || !selectedPostKey) return;
    queueRead('post', selectedPostKey);
  }, [readTrackingEnabled, selectedPostKey]);

  const openPost = useCallback(
    (post: ExplorePost) => {
      gridScrollRef.current = window.scrollY;
      openedFromGridScrollRef.current = window.scrollY;
      rememberGridScroll(explorePostKey(post));
      // Opened from the results: whatever pool was being read is over.
      setPoolContext(null);
      useExploreUiStore.getState().setExcursionNav(null);
      stepTo(post);
    },
    [rememberGridScroll, setPoolContext, stepTo]
  );

  // The open post is mirrored into `?post=`, so the browser's back button
  // returns to the results instead of leaving explore. Same single-action
  // rule as the gallery, so a change can never bounce between the two sides.
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const pendingPost = useExploreUiStore((state) => state.pendingPost);
  const setPendingPost = useExploreUiStore((state) => state.setPendingPost);
  const excursionNav = useExploreUiStore((state) => state.excursionNav);
  const setExcursionNav = useExploreUiStore(
    (state) => state.setExcursionNav
  );
  const urlPostKey = (location.search as { post?: string }).post;
  const onExploreRoute = location.pathname === '/app/explore';

  // Tracked only while the grid is the thing on screen. Off the route
  // because leaving scrolls the window to the top of the page arrived at,
  // and a listener still attached would record that as the place to come
  // back to; off the detail view because that scrolls the window itself.
  // Nothing is recorded eagerly either: the offset on the frame a detail
  // closes is still 0, and writing it would erase the place being restored.
  useEffect(() => {
    if (!onExploreRoute || selectedPost) return;
    return listenToUserScroll((scrollY) => {
      gridScrollRef.current = scrollY;
    });
  }, [onExploreRoute, selectedPost]);
  const previousUrlPostKeyRef = useRef<string | undefined>(undefined);
  // Tracks whether we pushed the entry, so closing pops it rather than
  // stacking a replace: otherwise every open/close cycle adds history.
  const detailEntryPushedRef = useRef(false);

  useEffect(() => {
    if (!urlPostKey) detailEntryPushedRef.current = false;
  }, [urlPostKey]);

  const closeDetail = useCallback(() => {
    // Reading a pool: back belongs to the pool the reader came from, not to
    // an explore search they may never have run.
    if (poolContext) {
      const { siteId, poolId } = poolContext;
      setPoolContext(null);
      setSelectedPost(null);
      void navigate({
        to: '/app/pool',
        search: { site: siteId, pool: poolId }
      });
      return;
    }
    if (excursionNav) {
      setSelectedPost(null);
      setExcursionNav(null);
      excursionNav.close();
      return;
    }
    if (detailEntryPushedRef.current) {
      detailEntryPushedRef.current = false;
      router.history.back();
      return;
    }
    setSelectedPost(null);
  }, [
    excursionNav,
    navigate,
    poolContext,
    router,
    setExcursionNav,
    setPoolContext
  ]);

  useEffect(() => {
    if (!onExploreRoute) return;
    if (
      pendingPost &&
      explorePostKey(pendingPost.post) === urlPostKey
    ) {
      return;
    }
    const action = getDetailUrlSyncAction({
      urlFileId: urlPostKey,
      previousUrlFileId: previousUrlPostKeyRef.current,
      selectedFileId: selectedPost ? explorePostKey(selectedPost) : undefined
    });

    if (action.type === 'open') {
      const match = posts.find(
        (post) => explorePostKey(post) === action.fileId
      );
      // The results may not hold this post yet (a reload lands here before
      // the first page arrives); leave the ref so the next update retries.
      if (!match) return;
      stepTo(match);
    } else if (action.type === 'close') {
      detailEntryPushedRef.current = false;
      setSelectedPost(null);
    } else if (action.type === 'mirror-url') {
      if (action.mode === 'push') detailEntryPushedRef.current = true;
      void navigate({
        to: '/app/explore',
        replace: action.mode === 'replace',
        search: { post: action.fileId }
      });
    } else if (action.type === 'clear-url') {
      detailEntryPushedRef.current = false;
      void navigate({
        to: '/app/explore',
        replace: true,
        search: { post: undefined }
      });
    }

    previousUrlPostKeyRef.current = urlPostKey;
  }, [
    navigate,
    onExploreRoute,
    pendingPost,
    posts,
    selectedPost,
    stepTo,
    urlPostKey
  ]);

  // A post handed over from somewhere else opens on arrival. It travels as an
  // object because the current results may not contain it; its identity is
  // already in the URL so Back has the right history entry from the start.
  useEffect(() => {
    if (!onExploreRoute || !pendingPost) return;
    setPendingPost(null);
    // An excursion shows the post without taking the reader's place with it.
    if (pendingPost.anchors) stepTo(pendingPost.post);
    else setSelectedPost(pendingPost.post);
  }, [onExploreRoute, pendingPost, setPendingPost, stepTo]);

  const openExcursion = useCallback(
    (post: ExplorePost) => setSelectedPost(post),
    []
  );
  const goRelative = excursionNav?.goRelative ?? sequenceGoRelative;
  const hasPrev = excursionNav?.hasPrev ?? anchorIndex > 0;
  const hasNext =
    excursionNav?.hasNext ??
    (anchorIndex >= 0 && (anchorIndex < navKeys.length - 1 || hasMore));
  const backLabel = excursionNav?.backLabel ??
    (poolContext ? 'Back to pool' : 'Back to explore');

  // The header owns Back and Prev/Next for the gallery; explore publishes the
  // same controls here so both pages get them from one place.
  const setDetailNav = useExploreUiStore((state) => state.setDetailNav);
  useEffect(() => {
    if (!selectedPost) {
      setDetailNav(null);
      return;
    }
    setDetailNav({
      backLabel,
      hasPrev,
      hasNext,
      goRelative,
      close: closeDetail
    });
  }, [
    selectedPost,
    backLabel,
    hasNext,
    hasPrev,
    goRelative,
    closeDetail,
    setDetailNav
  ]);

  // Leaving the page must not strand the header showing a post's controls.
  useEffect(
    () => () => {
      setDetailNav(null);
    },
    [setDetailNav]
  );

  return {
    sitesLoading: !sitesReady,
    searchableSites,
    disabledSiteIds,
    isSiteFilterOpen,
    setIsSiteFilterOpen,
    siteFilterRef,
    toggleSite,
    siteById,

    tagInput,
    setTagInput,
    submitSearch,
    selectTag,
    readTrackingEnabled,
    unreadOnly: effectiveUnreadOnly,
    toggleUnreadOnly,
    readHidden,

    sort,
    setSort,
    popularWindow,
    setPopularWindow,
    popularDate,
    stepPeriod,

    posts,
    siteErrors,
    loading,
    hasMore,
    exploreStackDuplicates,
    loadMore,
    markLoadedRead,

    selectedPost,
    // A neighbour not loaded yet (a pool page beyond what is in hand) is
    // null, and the swipe slides in a blank the way it does at the ends.
    prevPost: anchorIndex > 0 ? neighbourAt(anchorIndex - 1) : null,
    nextPost:
      anchorIndex >= 0 && anchorIndex < navKeys.length - 1
        ? neighbourAt(anchorIndex + 1)
        : null,
    openPost,
    openExcursion,
    backLabel,
    closeDetail,
    goRelative,
    hasPrev,
    hasNext,
    isFavorited,
    voteOf,
    actionError,
    pendingVoteKey,
    pendingFavoriteKey,
    votePost,
    toggleFavorite,
    hasSubscriptions,
    subscribedTags,
    subscriptionsLoading: sort === 'subscribed' && subscriptionTags.isLoading
  };
}
