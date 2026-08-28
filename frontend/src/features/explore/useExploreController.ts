import { useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import { getDetailUrlSyncAction } from '@/features/shell/galleryDetailSync';
import { useBooruEngineCatalog, useBooruSites } from '@/hooks/booru-sites';
import { useExploreUiStore } from '@/stores/exploreUiStore';

const PAGE_SIZE = 40;

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
  const pageRef = useRef(1);

  const [selectedPost, setSelectedPost] = useState<ExplorePost | null>(null);
  /**
   * Favorites added in this session. The server marks what it already knew
   * about, so this only has to cover the gap between a click and the next
   * fetch — which is why it is never cleared when results reload.
   */
  const [favoritedKeys, setFavoritedKeys] = useState<Set<string>>(
    () => new Set()
  );

  const isFavorited = useCallback(
    (post: ExplorePost) =>
      post.favorited || favoritedKeys.has(explorePostKey(post)),
    [favoritedKeys]
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
  const [pendingActionKey, setPendingActionKey] = useState<string | null>(null);

  const activeSiteIds = useMemo(
    () =>
      searchableSites
        .filter((site) => !disabledSiteIds.has(site.id))
        .map((site) => site.id),
    [searchableSites, disabledSiteIds]
  );
  const activeSiteKey = activeSiteIds.join(',');
  const sitesReady = sitesQuery.isSuccess && catalogQuery.isSuccess;

  const requestRef = useRef<AbortController | null>(null);

  const fetchPage = useCallback(
    async (page: number, append: boolean) => {
      if (sort === 'subscribed' || !activeSiteIds.length) {
        setPosts([]);
        setSiteErrors([]);
        setHasMore(false);
        setPageState({ loading: false, error: null });
        return;
      }
      // A newer search must win: the old one is aborted rather than left to
      // land late and overwrite the list the user is now looking at.
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setPageState({ loading: true, error: null });
      try {
        const data = await api.explorePosts({
          tags: tagQuery.split(/[\s,]+/).filter(Boolean),
          sort,
          window: popularWindow,
          date: popularDate,
          siteIds: activeSiteIds,
          page,
          limit: PAGE_SIZE,
          signal: controller.signal
        });
        pageRef.current = page;
        setSiteErrors(data.siteErrors);
        setHasMore(data.posts.length > 0);
        setPosts((prev) => {
          if (!append) return data.posts;
          const seen = new Set(prev.map(explorePostKey));
          return [
            ...prev,
            ...data.posts.filter((post) => !seen.has(explorePostKey(post)))
          ];
        });
        setPageState({ loading: false, error: null });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setPageState({ loading: false, error: (err as Error).message });
      }
    },
    [tagQuery, sort, popularWindow, popularDate, activeSiteIds]
  );

  // Wait for the site list before the first fetch, or it would search none.
  useEffect(() => {
    if (!sitesReady) return;
    void fetchPage(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sitesReady, tagQuery, sort, popularWindow, popularDate, activeSiteKey]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const loadMore = useCallback(() => {
    if (pageState.loading) return;
    void fetchPage(pageRef.current + 1, true);
  }, [fetchPage, pageState.loading]);

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

  const siteById = useMemo(
    () => new Map(searchableSites.map((site) => [site.id, site])),
    [searchableSites]
  );

  const votePost = useCallback(async (post: ExplorePost, score: 1 | -1) => {
    const key = explorePostKey(post);
    setActionError(null);
    setPendingActionKey(key);
    try {
      await api.exploreVote({
        siteId: post.siteId,
        remoteId: post.remoteId,
        score
      });
      let delta = 0;
      setVotedKeys((prev) => {
        delta = voteDelta(prev.get(key) ?? null, score);
        return new Map(prev).set(key, score);
      });
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
      setPendingActionKey(null);
    }
  }, []);

  const favoritePost = useCallback(async (post: ExplorePost) => {
    if (!post.fileUrl) {
      setActionError(`${post.siteName}: this post has no downloadable file`);
      return;
    }
    const key = explorePostKey(post);
    setActionError(null);
    setPendingActionKey(key);
    try {
      await api.exploreFavorite({
        siteId: post.siteId,
        remoteId: post.remoteId,
        fileUrl: post.fileUrl
      });
      setFavoritedKeys((prev) => new Set(prev).add(key));
    } catch (err) {
      setActionError(`${post.siteName}: ${(err as Error).message}`);
    } finally {
      setPendingActionKey(null);
    }
  }, []);

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
  const selectedIndexForNav = selectedPost
    ? posts.findIndex(
        (post) => explorePostKey(post) === explorePostKey(selectedPost)
      )
    : -1;
  const selectedIndex = selectedIndexForNav;

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
    openPost,
    closeDetail,
    goRelative,
    hasPrev: selectedIndex > 0,
    hasNext: selectedIndex >= 0 && selectedIndex < posts.length - 1,
    isFavorited,
    voteOf,
    actionError,
    pendingActionKey,
    votePost,
    favoritePost
  };
}
