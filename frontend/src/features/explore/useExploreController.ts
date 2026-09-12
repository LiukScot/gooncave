import { useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { shouldAutoVote } from './autoVote';
import {
  readExploreQuery,
  readExploreSnapshot,
  writeExploreSnapshot
} from './exploreSnapshot';
import {
  fillPages,
  openStreams,
  type FillOptions,
  type FillResult,
  type MergeSort,
  type SiteStream
} from './mergeStream';
import { explorePostKey } from './navSequence';
import { shiftAnchor, todayIso } from './popularPeriod';
import {
  collectSubscriptionPosts,
  subscriptionActionState
} from './subscriptionFeed';
import { useExploreSequence } from './useExploreSequence';
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
import { restoreScrollTo } from '@/features/file-detail/restoreScrollTo';
import { useDetailScrollRestore } from '@/features/file-detail/useDetailScrollRestore';
import { appendTagTerm } from '@/features/library/tagInputTokens';
import { flushReadQueue, queueRead } from '@/features/read-marks/readQueue';
import {
  readUnreadOnly,
  writeUnreadOnly
} from '@/features/read-marks/unreadOnly';
import {
  effectiveBlacklist,
  isBlacklisted,
  normalizeTag
} from '@/features/settings/blacklist';
import { getDetailUrlSyncAction } from '@/features/shell/galleryDetailSync';
import { useBooruEngineCatalog, useBooruSites } from '@/hooks/booru-sites';
import {
  useAddSubscriptionTag,
  useBlacklistSettings,
  useExtraSettings,
  useSubscriptionTags,
  useUpdateSubscriptionTags
} from '@/hooks/settings';
import { useExploreUiStore } from '@/stores/exploreUiStore';

const PAGE_SIZE = 40;
/**
 * How many pages one Load more may ask for. Sites ranked within a point of
 * each other release a post at a time; without a cap a search could keep
 * fetching, with one it costs at most this many requests.
 */
const MAX_FILL_ROUNDS = 5;

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

export function useExploreController() {
  const sitesQuery = useBooruSites();
  const catalogQuery = useBooruEngineCatalog();
  const choose = useChoose();
  const blacklist = useBlacklistSettings();
  const { autoVoteOnFavorite } = useExtraSettings();

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
  const addSubscriptionTag = useAddSubscriptionTag();
  const updateSubscriptionTags = useUpdateSubscriptionTags();

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

  const [votedKeys, setVotedKeys] = useState<Map<string, 1 | -1>>(
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
  const seenRef = useRef({
    keys: new Set<string>(),
    hashes: new Set<string>()
  });

  const mergeSort: MergeSort = sort === 'subscribed' ? 'new' : sort;

  /**
   * Whether a post joins the buffer — and, as a side effect, the record that
   * it was offered. Duplicates arrive from two directions: the same post on
   * two boorus (same md5) and the same post on two pages of one booru.
   */
  const keepPost = useCallback(
    (post: ExplorePost) => {
      const key = explorePostKey(post);
      const seen = seenRef.current;
      if (seen.keys.has(key)) return false;
      if (post.md5 && seen.hashes.has(post.md5)) return false;
      seen.keys.add(key);
      if (post.md5) seen.hashes.add(post.md5);
      // Recorded as offered either way, so a post dropped here cannot come
      // back from another site's page or a later one.
      if (unreadOnly && post.read) {
        readHiddenCountRef.current += 1;
        return false;
      }
      return !isBlacklisted(post.tags, hiddenTags);
    },
    [hiddenTags, unreadOnly]
  );

  const fetchSubscriptionPage = useCallback(
    (cursor: string | null, signal: AbortSignal) =>
      collectSubscriptionPosts({
        cursor,
        target: PAGE_SIZE,
        maxRounds: MAX_FILL_ROUNDS,
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
      limit: PAGE_SIZE,
      target: PAGE_SIZE,
      maxRounds: MAX_FILL_ROUNDS,
      keep: keepPost,
      signal,
      // A site error travels back as a rejection: to the merge, a site that
      // cannot answer and one that has run out are the same thing.
      fetchPage: async (siteId, page) => {
        const data = await api.explorePosts({
          tags: tagQuery.split(/[\s,]+/).filter(Boolean),
          sort: mergeSort,
          window: popularWindow,
          date: popularDate,
          siteIds: [siteId],
          page,
          limit: PAGE_SIZE,
          signal
        });
        if (data.siteErrors.length) throw new Error(data.siteErrors[0].error);
        return data.posts;
      }
    }),
    [keepPost, mergeSort, popularDate, popularWindow, tagQuery]
  );

  const applyResult = useCallback(
    (result: FillResult) => {
      streamsRef.current = result.streams;
      setPosts((prev) => [...prev, ...result.posts]);
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
    seenRef.current = { keys: new Set(), hashes: new Set() };
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
    if (unreadOnly) await flushReadQueue();
    if (sort === 'subscribed') {
      const initial = await fetchSubscriptionPage(null, controller.signal);
      if (controller.signal.aborted) return;
      if (initial.posts.length > 0 || initial.hasMore) {
        subscriptionCursorRef.current = initial.nextCursor;
        setPosts(initial.posts);
        setHasMore(initial.hasMore);
        setLoading(false);
        // Background refresh keeps the index warm; the current cursor remains stable.
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
        return;
      }
      const refreshed = await api.refreshExploreSubscriptions();
      if (controller.signal.aborted) return;
      seenRef.current = { keys: new Set(), hashes: new Set() };
      const first = await fetchSubscriptionPage(null, controller.signal);
      if (controller.signal.aborted) return;
      subscriptionCursorRef.current = first.nextCursor;
      setPosts(first.posts);
      setSiteErrors(refreshed.errors);
      setHasMore(first.hasMore);
      setLoading(false);
      return;
    }
    const result = await openStreams(
      activeSiteIds,
      fillOptions(controller.signal)
    );
    if (controller.signal.aborted) return;
    applyResult(result);
    setLoading(false);
  }, [
    activeSiteIds,
    applyResult,
    fetchSubscriptionPage,
    fillOptions,
    sort,
    unreadOnly
  ]);

  /** Identity of the search on screen — exactly what a reload depends on. */
  const searchKey = [
    tagQuery,
    sort,
    popularWindow,
    popularDate,
    activeSiteKey,
    unreadOnly ? 'unread' : 'all'
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
      servedKeyRef.current === null && sort !== 'subscribed'
        ? readExploreSnapshot(searchKey)
        : null;
    servedKeyRef.current = searchKey;
    if (snapshot) {
      // Load more needs a live controller, and this mount has none yet.
      requestRef.current = new AbortController();
      streamsRef.current = snapshot.streams;
      seenRef.current = snapshot.seen;
      setPosts(snapshot.posts);
      setSiteErrors(snapshot.siteErrors);
      setHasMore(snapshot.hasMore);
      setLoading(false);
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
    unreadOnly
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
  const latestRef = useRef({ searchKey, query, posts, siteErrors, hasMore });
  latestRef.current = { searchKey, query, posts, siteErrors, hasMore };

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
      // Subscription cursors are remote, opaque positions. Replaying the
      // visible cards without those cursors would make Load more repeat page 1.
      if (!latest.posts.length || latest.query.sort === 'subscribed') return;
      writeExploreSnapshot({
        key: latest.searchKey,
        query: latest.query,
        posts: latest.posts,
        siteErrors: latest.siteErrors,
        hasMore: latest.hasMore,
        streams: streamsRef.current,
        seen: seenRef.current,
        scrollY: gridScrollRef.current
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
      if (sort === 'subscribed') {
        const result = await fetchSubscriptionPage(
          subscriptionCursorRef.current,
          controller.signal
        );
        if (controller.signal.aborted) return [];
        subscriptionCursorRef.current = result.nextCursor;
        setPosts((current) => [...current, ...result.posts]);
        setHasMore(result.hasMore);
        return result.posts;
      }
      const result = await fillPages(
        streamsRef.current,
        fillOptions(controller.signal)
      );
      if (controller.signal.aborted) return [];
      applyResult(result);
      return result.posts;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [applyResult, fetchSubscriptionPage, fillOptions, loading, sort]);

  const submitSearch = useCallback(() => setTagQuery(tagInput), [tagInput]);

  /**
   * Runs the explore search off a tag pill. Same two actions as the gallery,
   * with the same meaning: Search adds the tag to what is already in the box
   * rather than replacing it (issue #307).
   */
  const selectTag = useCallback(
    async (tag: string) => {
      const subscribeAction = subscriptionActionState(tag, subscribedTags);
      const mode = await choose('', {
        title: tag,
        actions: [
          { value: 'search', label: 'Search tag' },
          {
            value: subscribeAction.subscribed ? 'unsubscribe' : 'subscribe',
            label: subscribeAction.label,
            variant: subscribeAction.subscribed ? 'destructive' : 'default'
          }
        ]
      });
      if (!mode) return;
      if (mode === 'subscribe') {
        try {
          await addSubscriptionTag.mutateAsync(tag);
          toast.success(`Subscribed to ${tag}`);
        } catch (error) {
          toast.error((error as Error).message);
        }
        return;
      }
      if (mode === 'unsubscribe') {
        try {
          const normalizedTag = normalizeTag(tag);
          await updateSubscriptionTags.mutateAsync(
            subscribedTags.filter(
              (subscribedTag) => normalizeTag(subscribedTag) !== normalizedTag
            )
          );
          toast.success(`Removed subscription to ${tag}`);
        } catch (error) {
          toast.error((error as Error).message);
        }
        return;
      }
      const next = appendTagTerm(tagInput, tag);
      setTagInput(next);
      setTagQuery(next);
      setSelectedPost(null);
    },
    [
      addSubscriptionTag,
      choose,
      subscribedTags,
      tagInput,
      updateSubscriptionTags
    ]
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
      setActionError(null);
      setPendingVoteKey(key);
      try {
        await api.exploreVote({
          siteId: post.siteId,
          remoteId: post.remoteId,
          score
        });
        // Read the previous vote before touching state: computing it inside
        // the updater would make the updater impure, and React is free to run
        // those more than once.
        const delta = voteDelta(voteOf(post), score);
        setVotedKeys((prev) => new Map(prev).set(key, score));
        // A vote that leaves the page exactly as it was reads as a dead
        // button, so the score moves here rather than after a refetch.
        if (delta !== 0) {
          const applyDelta = (target: ExplorePost): ExplorePost =>
            target.score === null
              ? target
              : { ...target, score: target.score + delta };
          setPosts((prev) =>
            prev.map((entry) =>
              explorePostKey(entry) === key ? applyDelta(entry) : entry
            )
          );
          setSelectedPost((current) =>
            current && explorePostKey(current) === key
              ? applyDelta(current)
              : current
          );
        }
      } catch (err) {
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
      setActionError(null);
      setPendingFavoriteKey(key);
      setFavoriteOverrides((prev) => new Map(prev).set(key, !favorited));
      try {
        if (favorited) {
          await api.exploreUnfavorite({
            siteId: post.siteId,
            remoteId: post.remoteId
          });
        } else {
          await api.exploreFavorite({
            siteId: post.siteId,
            remoteId: post.remoteId,
            fileUrl: post.fileUrl ?? undefined
          });
          // After the favorite, never instead of it: a booru that rejects the
          // vote must not roll back a favorite it already accepted, and
          // `votePost` reports its own failure without throwing.
          if (
            shouldAutoVote(
              autoVoteOnFavorite,
              siteById.get(post.siteId)?.canVote ?? false,
              voteOf(post)
            )
          ) {
            await votePost(post, 1);
          }
        }
      } catch (err) {
        setFavoriteOverrides((prev) => new Map(prev).set(key, favorited));
        setActionError(`${post.siteName}: ${(err as Error).message}`);
      } finally {
        setPendingFavoriteKey(null);
      }
    },
    [autoVoteOnFavorite, siteById, voteOf, votePost]
  );

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
    setUnreadOnly((previous) => {
      writeUnreadOnly('explore', !previous);
      return !previous;
    });
  }, []);

  // Same rule as the gallery: looking at a post counts as reading it, keyed
  // on the selection so that a deep link, the back button, the arrows and a
  // swipe all count — not only a click on the card.
  const selectedPostKey = selectedPost ? explorePostKey(selectedPost) : null;
  useEffect(() => {
    if (!unreadOnly || !selectedPostKey) return;
    queueRead('post', selectedPostKey);
  }, [selectedPostKey, unreadOnly]);

  const openPost = useCallback(
    (post: ExplorePost) => {
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
    const onScroll = () => {
      gridScrollRef.current = window.scrollY;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
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
    unreadOnly,
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
    loadMore,

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
    subscriptionsLoading: sort === 'subscribed' && subscriptionTags.isLoading
  };
}
