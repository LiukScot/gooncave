import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { anchorIndexOf, explorePostKey, relativeStep } from './navSequence';

import { api, type ExplorePost } from '@/api';
import type { useExploreUiStore } from '@/stores/exploreUiStore';

type PoolContext = ReturnType<typeof useExploreUiStore.getState>['poolContext'];

export type ExploreSequence = {
  /** Every post of the sequence, in order, as `siteId:remoteId`. */
  navKeys: string[];
  /** Where the reader stands in it; -1 when they stand outside it. */
  anchorIndex: number;
  /** Moves along the sequence: the open post and the place travel together. */
  stepTo: (post: ExplorePost) => void;
  /** Prev/Next, the arrows and a swipe. */
  goRelative: (delta: number) => void;
  /** The post at that place, when it is one of the loaded ones. */
  neighbourAt: (index: number) => ExplorePost | null;
};

/**
 * What Prev/Next, the arrows and a swipe move through: a pool the reader
 * opened as a gallery, first page to last, and otherwise the results on
 * screen. Opening a pool's page from the navigator above a post does not
 * start a pool here — that block is a way out of the post, not a sequence
 * the reader chose to read.
 */
export const useExploreSequence = ({
  posts,
  poolContext,
  setPoolContext,
  selectedPost,
  setSelectedPost,
  onStep,
  hasMore,
  loading,
  loadMore
}: {
  posts: ExplorePost[];
  poolContext: PoolContext;
  setPoolContext: (context: PoolContext) => void;
  selectedPost: ExplorePost | null;
  setSelectedPost: (post: ExplorePost) => void;
  onStep?: (post: ExplorePost) => void;
  hasMore: boolean;
  loading: boolean;
  loadMore: () => Promise<ExplorePost[]>;
}): ExploreSequence => {
  const navKeys = useMemo(
    () =>
      poolContext
        ? poolContext.postIds.map((id) => `${poolContext.siteId}:${id}`)
        : posts.map(explorePostKey),
    [poolContext, posts]
  );
  const knownPosts = poolContext ? poolContext.posts : posts;
  const selectedKey = selectedPost ? explorePostKey(selectedPost) : null;
  /**
   * The last post reached through the sequence itself. A post opened as an
   * excursion — a pool navigator's Prev/Next, a related post — is not in the
   * sequence, and leaves this where it was, so the next arrow carries on
   * beside the post the reader had actually opened.
   */
  const [anchorKey, setAnchorKey] = useState<string | null>(null);
  const anchorIndex = anchorIndexOf(navKeys, selectedKey, anchorKey);
  const navigationGenerationRef = useRef(0);
  const prefetchedRef = useRef<{
    edgeKey: string;
    promise: Promise<ExplorePost[]>;
    loaded?: ExplorePost[];
  } | null>(null);
  const prefetchedForAnchorRef = useRef<string | null>(null);
  const poolPrefetchedRef = useRef<{
    key: string;
    promise: ReturnType<typeof api.explorePost>;
  } | null>(null);

  useEffect(() => {
    if (!selectedPost) {
      prefetchedRef.current = null;
      prefetchedForAnchorRef.current = null;
      return;
    }
    if (poolContext || !hasMore || loading) return;
    if (anchorIndex < navKeys.length - 2 || anchorIndex < 0) return;
    const edgeKey = navKeys.at(-1);
    if (!edgeKey || prefetchedForAnchorRef.current === selectedKey) return;
    prefetchedForAnchorRef.current = selectedKey;
    const prefetch = {
      edgeKey,
      promise: loadMore(),
      loaded: undefined as ExplorePost[] | undefined
    };
    prefetchedRef.current = prefetch;
    void prefetch.promise.then(
      (loaded) => { prefetch.loaded = loaded; },
      () => { prefetch.loaded = []; }
    );
  }, [
    anchorIndex,
    hasMore,
    loadMore,
    loading,
    navKeys,
    poolContext,
    selectedKey,
    selectedPost
  ]);

  useEffect(() => {
    if (!poolContext || !selectedPost || anchorIndex < 0) return;
    const key = navKeys[anchorIndex + 1];
    if (!key || knownPosts.some((post) => explorePostKey(post) === key)) return;
    const controller = new AbortController();
    const promise = api.explorePost(
      poolContext.siteId,
      key.slice(poolContext.siteId.length + 1),
      controller.signal
    );
    const prefetch = { key, promise };
    poolPrefetchedRef.current = prefetch;
    void promise.catch((err: Error) => {
      if (poolPrefetchedRef.current === prefetch) poolPrefetchedRef.current = null;
      if (!controller.signal.aborted) {
        console.warn(`[pools] next page preload failed: ${err.message}`);
      }
    });
    return () => {
      controller.abort();
      if (poolPrefetchedRef.current === prefetch) poolPrefetchedRef.current = null;
    };
  }, [anchorIndex, knownPosts, navKeys, poolContext, selectedPost]);

  /**
   * Moves the reader: the open post and their place in the sequence travel
   * together. Only the ways of moving *along* the sequence call this — a
   * tile, an arrow, a swipe, a page picked out of the pool gallery. An
   * excursion opens a post with setSelectedPost alone, which is what keeps
   * the place still while the reader looks around.
   */
  const stepTo = useCallback(
    (post: ExplorePost) => {
      navigationGenerationRef.current += 1;
      setSelectedPost(post);
      setAnchorKey(explorePostKey(post));
      onStep?.(post);
    },
    [onStep, setSelectedPost]
  );

  const goRelative = useCallback(
    (delta: number) => {
      const generation = ++navigationGenerationRef.current;
      if (anchorIndex < 0) return;
      const step = relativeStep(
        anchorIndex,
        delta,
        navKeys.length,
        !poolContext && hasMore
      );
      if (step === null) return;
      if (step === 'load-next') {
        const edgeKey = navKeys.at(-1);
        const pending =
          edgeKey &&
          prefetchedRef.current?.edgeKey === edgeKey &&
          prefetchedRef.current.loaded?.length !== 0
            ? prefetchedRef.current.promise
            : loadMore();
        void pending.then((loaded) => {
          if (generation !== navigationGenerationRef.current) return;
          const next = loaded[0];
          if (next) stepTo(next);
        });
        return;
      }
      const targetKey = navKeys[step];
      const known = knownPosts.find(
        (post) => explorePostKey(post) === targetKey
      );
      if (known) {
        stepTo(known);
        return;
      }
      if (!poolContext) return;
      // A pool page nobody has loaded yet: read it on the way there.
      const { siteId, poolId, postIds } = poolContext;
      const pending = poolPrefetchedRef.current?.key === targetKey
        ? poolPrefetchedRef.current.promise
        : api.explorePost(siteId, targetKey.slice(siteId.length + 1));
      pending
        .then(({ post }) => {
          if (generation !== navigationGenerationRef.current) return;
          setPoolContext({
            siteId,
            poolId,
            postIds,
            posts: [...knownPosts, post]
          });
          stepTo(post);
        })
        .catch((err: Error) => {
          toast.error(`Could not open the next page: ${err.message}`);
        });
    },
    [
      anchorIndex,
      hasMore,
      knownPosts,
      loadMore,
      navKeys,
      poolContext,
      setPoolContext,
      stepTo
    ]
  );

  const neighbourAt = (index: number): ExplorePost | null =>
    knownPosts.find((post) => explorePostKey(post) === navKeys[index]) ?? null;

  return { navKeys, anchorIndex, stepTo, goRelative, neighbourAt };
};
