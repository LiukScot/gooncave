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
import {
  effectiveBlacklist,
  isBlacklisted
} from '@/features/settings/blacklist';
import { getDetailUrlSyncAction } from '@/features/shell/galleryDetailSync';
import { useBooruEngineCatalog, useBooruSites } from '@/hooks/booru-sites';
import { useBlacklistSettings, useExtraSettings } from '@/hooks/settings';
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
};

export { explorePostKey };

export function useExploreController() {
  const sitesQuery = useBooruSites();
  const catalogQuery = useBooruEngineCatalog();
  const choose = useChoose();
  const blacklist = useBlacklistSettings();
  const { autoVoteOnFavorite } = useExtraSettings();

  const searchableSites: ExploreSiteOption[] = useMemo(() => {
    const capsByType = new Map(
      (catalogQuery.data?.engines ?? []).map((engine) => [
        engine.type,
        engine.defaultCapabilities
      ])
    );
    return (sitesQuery.data ?? [])
      .filter((site) => site.enabled && capsByType.get(site.engine)?.search)
      .map((site) => ({
        ...site,
        supportsVote: capsByType.get(site.engine)?.vote ?? false,
        // Voting is an account action. The control still shows for a
        // votable engine without credentials, disabled and saying why —
        // hiding it looks identical to "this booru has no voting".
        canVote:
          (capsByType.get(site.engine)?.vote ?? false) &&
          Boolean(site.username) &&
          site.hasApiKey,
        canFavorite:
          (capsByType.get(site.engine)?.favorites ?? false) &&
          Boolean(site.username) &&
          site.hasApiKey
      }));
  }, [sitesQuery.data, catalogQuery.data]);

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
  const [isSiteFilterOpen, setIsSiteFilterOpen] = useState(false);
  const siteFilterRef = useRef<HTMLDivElement | null>(null);

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

  const activeSiteIds = useMemo(
    () =>
      searchableSites
        .filter((site) => !disabledSiteIds.has(site.id))
        .map((site) => site.id),
    [searchableSites, disabledSiteIds]
  );
  const activeSiteKey = activeSiteIds.join(',');
  const sitesReady =
    sitesQuery.isSuccess && catalogQuery.isSuccess && blacklist.loaded;

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
      return !isBlacklisted(post.tags, hiddenTags);
    },
    [hiddenTags]
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
    seenRef.current = { keys: new Set(), hashes: new Set() };
    setPosts([]);
    setSiteErrors([]);
    setHasMore(false);
    if (sort === 'subscribed' || !activeSiteIds.length) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const result = await openStreams(
      activeSiteIds,
      fillOptions(controller.signal)
    );
    if (controller.signal.aborted) return;
    applyResult(result);
    setLoading(false);
  }, [activeSiteIds, applyResult, fillOptions, sort]);

  /** Identity of the search on screen — exactly what a reload depends on. */
  const searchKey = [
    tagQuery,
    sort,
    popularWindow,
    popularDate,
    activeSiteKey
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
  }, [sitesReady, tagQuery, sort, popularWindow, popularDate, activeSiteKey]);

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
      if (!latest.posts.length) return;
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

  const loadMore = useCallback(() => {
    if (loading) return;
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
    void fillPages(streamsRef.current, fillOptions(controller.signal)).then(
      (result) => {
        if (controller.signal.aborted) return;
        applyResult(result);
        setLoading(false);
      }
    );
  }, [applyResult, fillOptions, loading]);

  const submitSearch = useCallback(() => setTagQuery(tagInput), [tagInput]);

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
          { value: 'subscribe', label: 'Subscribe' }
        ]
      });
      if (!mode) return;
      if (mode === 'subscribe') {
        toast.info('Subscriptions are not available yet.');
        return;
      }
      const next = appendTagTerm(tagInput, tag);
      setTagInput(next);
      setTagQuery(next);
      setSelectedPost(null);
    },
    [choose, tagInput]
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
      if (!favorited && !post.fileUrl) {
        setActionError(`${post.siteName}: this post has no downloadable file`);
        return;
      }
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
            fileUrl: post.fileUrl!
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

  const { navKeys, anchorIndex, stepTo, goRelative, neighbourAt } =
    useExploreSequence({
      posts,
      poolContext,
      setPoolContext,
      selectedPost,
      setSelectedPost
    });

  const rememberGridScroll = useDetailScrollRestore(
    selectedPost ? explorePostKey(selectedPost) : null
  );

  const openPost = useCallback(
    (post: ExplorePost) => {
      rememberGridScroll();
      // Opened from the results: whatever pool was being read is over.
      setPoolContext(null);
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
  const previousUrlPostKeyRef = useRef<string | undefined>(urlPostKey);
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
    if (detailEntryPushedRef.current) {
      detailEntryPushedRef.current = false;
      router.history.back();
      return;
    }
    setSelectedPost(null);
  }, [navigate, poolContext, router, setPoolContext]);

  useEffect(() => {
    if (!onExploreRoute) return;
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
  }, [navigate, onExploreRoute, posts, selectedPost, stepTo, urlPostKey]);

  // A post handed over from somewhere else — the related posts of a gallery
  // file — opens on arrival. It is not in the results and never will be, so
  // it travels as an object rather than as an id in the URL; the effect above
  // then mirrors it into `?post=` like any other open post.
  useEffect(() => {
    if (!onExploreRoute || !pendingPost) return;
    setPendingPost(null);
    // An excursion shows the post without taking the reader's place with it.
    if (pendingPost.anchors) stepTo(pendingPost.post);
    else setSelectedPost(pendingPost.post);
  }, [onExploreRoute, pendingPost, setPendingPost, stepTo]);

  // The header owns Back and Prev/Next for the gallery; explore publishes the
  // same controls here so both pages get them from one place.
  const setDetailNav = useExploreUiStore((state) => state.setDetailNav);
  useEffect(() => {
    if (!selectedPost) {
      setDetailNav(null);
      return;
    }
    setDetailNav({
      hasPrev: anchorIndex > 0,
      hasNext: anchorIndex >= 0 && anchorIndex < navKeys.length - 1,
      goRelative,
      close: closeDetail
    });
  }, [
    selectedPost,
    anchorIndex,
    navKeys.length,
    goRelative,
    closeDetail,
    setDetailNav
  ]);

  // Leaving the page must not strand the header showing a post's controls.
  useEffect(() => () => setDetailNav(null), [setDetailNav]);

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
    closeDetail,
    goRelative,
    hasPrev: anchorIndex > 0,
    hasNext: anchorIndex >= 0 && anchorIndex < navKeys.length - 1,
    isFavorited,
    voteOf,
    actionError,
    pendingVoteKey,
    pendingFavoriteKey,
    votePost,
    toggleFavorite
  };
}
