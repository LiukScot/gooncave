import { create } from 'zustand';

import type { ExplorePost } from '@/api';

/**
 * What the app header needs to drive an open explore post: the same Back and
 * Prev/Next controls the gallery gets. Those buttons live in the shell, above
 * the routed view, so the explore controller publishes its navigation here
 * rather than the shell reaching down into a view it does not own.
 *
 * Null means no post is open and the header shows the plain navigation.
 */
export type ExploreDetailNav = {
  hasPrev: boolean;
  hasNext: boolean;
  goRelative: (delta: number) => void;
  close: () => void;
};

type ExploreUiStore = {
  detailNav: ExploreDetailNav | null;
  setDetailNav: (nav: ExploreDetailNav | null) => void;
  /**
   * A post explore is being sent to open from somewhere else — a related
   * post, a pool page — which the current results do not hold. Explore opens
   * it and clears this; a reload drops it and lands on the plain results,
   * which is the honest fallback.
   *
   * `anchors` says whether it also becomes the reader's place in the
   * sequence. False for an excursion — a pool navigator's Prev/Next, a
   * related post: the reader is looking away from where they stand, not
   * moving, so their place stays put however far the excursion wanders.
   * True for a page picked out of the pool gallery, which is a choice of
   * where to stand.
   */
  pendingPost: { post: ExplorePost; anchors: boolean } | null;
  setPendingPost: (
    pending: { post: ExplorePost; anchors: boolean } | null
  ) => void;
  /**
   * The pool a reader is stepping through. Set when a post is opened from
   * the pool view or through a navigator's Prev/Next: the detail then pages
   * through the pool rather than through explore's search results, and
   * closing returns to the pool.
   *
   * `postIds` is the whole pool in reading order; `posts` is whatever of it
   * is already in hand, and a page missing from it is fetched when stepped
   * onto.
   */
  poolContext: {
    siteId: string;
    poolId: string;
    postIds: string[];
    posts: ExplorePost[];
  } | null;
  setPoolContext: (context: ExploreUiStore['poolContext']) => void;
  /**
   * The page a pool was opened from. The pool view offers the way back to
   * it, which is not the same as the browser's own back: that returns to the
   * post the navigator was on, and the reader is asking for the grid they
   * left. Null when a pool was opened cold, from a link or a reload.
   */
  poolOrigin: string | null;
  setPoolOrigin: (path: string | null) => void;
};

export const useExploreUiStore = create<ExploreUiStore>((set) => ({
  detailNav: null,
  setDetailNav: (detailNav) => set({ detailNav }),
  pendingPost: null,
  setPendingPost: (pendingPost) => set({ pendingPost }),
  poolContext: null,
  setPoolContext: (poolContext) => set({ poolContext }),
  poolOrigin: null,
  setPoolOrigin: (poolOrigin) => set({ poolOrigin })
}));
