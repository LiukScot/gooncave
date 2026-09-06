import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { anchorIndexOf, explorePostKey } from './navSequence';

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
  setSelectedPost
}: {
  posts: ExplorePost[];
  poolContext: PoolContext;
  setPoolContext: (context: PoolContext) => void;
  selectedPost: ExplorePost | null;
  setSelectedPost: (post: ExplorePost) => void;
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

  /**
   * Moves the reader: the open post and their place in the sequence travel
   * together. Only the ways of moving *along* the sequence call this — a
   * tile, an arrow, a swipe, a page picked out of the pool gallery. An
   * excursion opens a post with setSelectedPost alone, which is what keeps
   * the place still while the reader looks around.
   */
  const stepTo = useCallback(
    (post: ExplorePost) => {
      setSelectedPost(post);
      setAnchorKey(explorePostKey(post));
    },
    [setSelectedPost]
  );

  const goRelative = useCallback(
    (delta: number) => {
      if (anchorIndex < 0) return;
      const targetKey = navKeys[anchorIndex + delta];
      if (!targetKey) return;
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
      api
        .explorePost(siteId, targetKey.slice(siteId.length + 1))
        .then(({ post }) => {
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
    [anchorIndex, knownPosts, navKeys, poolContext, setPoolContext, stepTo]
  );

  const neighbourAt = (index: number): ExplorePost | null =>
    knownPosts.find((post) => explorePostKey(post) === navKeys[index]) ?? null;

  return { navKeys, anchorIndex, stepTo, goRelative, neighbourAt };
};
