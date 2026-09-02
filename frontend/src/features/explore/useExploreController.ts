import { useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { shouldAutoVote } from './autoVote';
import {
  fillPages,
  openStreams,
  type FillOptions,
  type FillResult,
  type MergeSort,
  type SiteStream
} from './mergeStream';
import { shiftAnchor, todayIso } from './popularPeriod';
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
import { useDetailScrollRestore } from '@/features/file-detail/useDetailScrollRestore';
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

export type ExploreFetchState = { loading: boolean; error: string | null };

export type ExploreSiteOption = BooruSite & {
  /** The engine has a vote API at all. */
  supportsVote: boolean;
  /** …and this account can actually use it. */
  canVote: boolean;
  /** The booru takes favorites and this account has the key to send one. */
  canFavorite: boolean;
};

/** Identity of a post across sites: two boorus reuse the same numbers. */
export const explorePostKey = (post: ExplorePost) =>
  `${post.siteId}:${post.remoteId}`;

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

  const [tagInput, setTagInput] = useState('');
  const [tagQuery, setTagQuery] = useState('');
  const [sort, setSort] = useState<ExploreSort>('new');
  const [popularWindow, setPopularWindow] = useState<ExploreWindow>('day');
  /** Any date inside the period shown; the backend widens it to the period. */
  const [popularDate, setPopularDate] = useState<string>(() => todayIso());
  const [disabledSiteIds, setDisabledSiteIds] = useState<Set<string>>(
    () => new Set()
  );
  const [isSiteFilterOpen, setIsSiteFilterOpen] = useState(false);
  const siteFilterRef = useRef<HTMLDivElement | null>(null);

  const [posts, setPosts] = useState<ExplorePost[]>([]);
  const [siteErrors, setSiteErrors] = useState<ExploreSiteError[]>([]);
  const [pageState, setPageState] = useState<ExploreFetchState>({
    loading: false,
    error: null
  });
  const [hasMore, setHasMore] = useState(false);

  const [selectedPost, setSelectedPost] = useState<ExplorePost | null>(null);
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
      setPageState({ loading: false, error: null });
      return;
    }
    setPageState({ loading: true, error: null });
    const result = await openStreams(
      activeSiteIds,
      fillOptions(controller.signal)
    );
    if (controller.signal.aborted) return;
    applyResult(result);
    setPageState({ loading: false, error: null });
  }, [activeSiteIds, applyResult, fillOptions, sort]);

  // Wait for the site list and the blacklist before the first fetch: without
  // the sites it would search none, without the blacklist it would show what
  // the blacklist is there to hide.
  useEffect(() => {
    if (!sitesReady) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sitesReady, tagQuery, sort, popularWindow, popularDate, activeSiteKey]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const loadMore = useCallback(() => {
    const controller = requestRef.current;
    if (pageState.loading || !controller || controller.signal.aborted) return;
    setPageState({ loading: true, error: null });
    void fillPages(streamsRef.current, fillOptions(controller.signal)).then(
      (result) => {
        if (controller.signal.aborted) return;
        applyResult(result);
        setPageState({ loading: false, error: null });
      }
    );
  }, [applyResult, fillOptions, pageState.loading]);

  const submitSearch = useCallback(() => setTagQuery(tagInput), [tagInput]);

  /**
   * The tag actions from the gallery, plus Subscribe. Same operators as the
   * gallery search (`~` any, `-` exclude), so a query that would need typing
   * them by hand can be built from the pills instead.
   */
  const selectTag = useCallback(
    async (tag: string) => {
      const mode = await choose('Add this tag to the search?', {
        title: 'Filter by tag',
        details: tag,
        actions: [
          { value: 'all', label: 'And', variant: 'warning' },
          { value: 'any', label: 'Or', variant: 'warning' },
          { value: 'none', label: 'Exclude', variant: 'warning' },
          { value: 'subscribe', label: 'Subscribe' }
        ]
      });
      if (!mode) return;
      if (mode === 'subscribe') {
        setActionError('Subscriptions are not available yet.');
        return;
      }
      const prefix = mode === 'any' ? '~' : mode === 'none' ? '-' : '';
      // The same tag under any operator is dropped first, so picking Exclude
      // on a tag already required replaces it instead of building
      // `wolf -wolf`, which matches nothing.
      const terms = (
        tagInput.trim() ? tagInput.trim().split(/\s+/) : []
      ).filter((existing) => existing.replace(/^[~-]/, '') !== tag);
      terms.push(`${prefix}${tag}`);
      const next = terms.join(' ');
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

  const goRelative = useCallback(
    (delta: number) => {
      setSelectedPost((current) => {
        if (!current) return current;
        const index = posts.findIndex(
          (post) => explorePostKey(post) === explorePostKey(current)
        );
        return posts[index + delta] ?? current;
      });
    },
    [posts]
  );

  const rememberGridScroll = useDetailScrollRestore(
    selectedPost ? explorePostKey(selectedPost) : null
  );

  const openPost = useCallback(
    (post: ExplorePost) => {
      rememberGridScroll();
      setSelectedPost(post);
    },
    [rememberGridScroll]
  );

  // The open post is mirrored into `?post=`, so the browser's back button
  // returns to the results instead of leaving explore. Same single-action
  // rule as the gallery, so a change can never bounce between the two sides.
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const urlPostKey = (location.search as { post?: string }).post;
  const onExploreRoute = location.pathname === '/app/explore';
  const previousUrlPostKeyRef = useRef<string | undefined>(urlPostKey);
  // Tracks whether we pushed the entry, so closing pops it rather than
  // stacking a replace: otherwise every open/close cycle adds history.
  const detailEntryPushedRef = useRef(false);

  useEffect(() => {
    if (!urlPostKey) detailEntryPushedRef.current = false;
  }, [urlPostKey]);

  const closeDetail = useCallback(() => {
    if (detailEntryPushedRef.current) {
      detailEntryPushedRef.current = false;
      router.history.back();
      return;
    }
    setSelectedPost(null);
  }, [router]);

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
      setSelectedPost(match);
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
  }, [navigate, onExploreRoute, posts, selectedPost, urlPostKey]);

  // The header owns Back and Prev/Next for the gallery; explore publishes the
  // same controls here so both pages get them from one place.
  const setDetailNav = useExploreUiStore((state) => state.setDetailNav);
  const selectedIndex = selectedPost
    ? posts.findIndex(
        (post) => explorePostKey(post) === explorePostKey(selectedPost)
      )
    : -1;
  useEffect(() => {
    if (!selectedPost) {
      setDetailNav(null);
      return;
    }
    setDetailNav({
      hasPrev: selectedIndex > 0,
      hasNext: selectedIndex >= 0 && selectedIndex < posts.length - 1,
      goRelative,
      close: closeDetail
    });
  }, [
    selectedPost,
    selectedIndex,
    posts.length,
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
    pageState,
    hasMore,
    loadMore,

    selectedPost,
    prevPost: selectedIndex > 0 ? (posts[selectedIndex - 1] ?? null) : null,
    nextPost:
      selectedIndex >= 0 && selectedIndex < posts.length - 1
        ? (posts[selectedIndex + 1] ?? null)
        : null,
    openPost,
    closeDetail,
    goRelative,
    hasPrev: selectedIndex > 0,
    hasNext: selectedIndex >= 0 && selectedIndex < posts.length - 1,
    isFavorited,
    voteOf,
    actionError,
    pendingVoteKey,
    pendingFavoriteKey,
    votePost,
    toggleFavorite
  };
}
