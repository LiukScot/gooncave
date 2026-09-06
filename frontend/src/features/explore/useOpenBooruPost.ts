import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import type { LibraryAwarePost } from '@/api';
import { useExploreUiStore } from '@/stores/exploreUiStore';

/**
 * Shows a booru post in explore's detail view. The post travels as an object
 * rather than as an id in the URL because explore's results do not hold it,
 * and searching them for it would find nothing.
 *
 * `anchors` decides whether the reader's place in the sequence travels with
 * it — see pendingPost in the explore UI store.
 */
const useShowPostInExplore = (
  anchors: boolean
): ((post: LibraryAwarePost) => void) => {
  const navigate = useNavigate();
  const setPendingPost = useExploreUiStore((state) => state.setPendingPost);
  return useCallback(
    (post: LibraryAwarePost) => {
      setPendingPost({ post, anchors });
      void navigate({ to: '/app/explore', search: { post: undefined } });
    },
    [anchors, navigate, setPendingPost]
  );
};

/**
 * Opens a post the reader is looking *aside* to — a pool navigator's Prev or
 * Next. Their place in whatever they were reading does not move, so the
 * arrows carry on from beside the post they had actually opened, however
 * many pages of the pool they turned.
 *
 * Stays in the detail view even for a page already in the library: a reader
 * turning the page of a comic wants the page, not a jump into the gallery.
 */
export const useOpenExcursionPost = (): ((post: LibraryAwarePost) => void) =>
  useShowPostInExplore(false);

/**
 * Opens a booru post where it lives: the library file when this account
 * already saved it, and explore's detail view otherwise. Never the booru
 * itself — leaving the app to look at a post the app can show is a dead end.
 *
 * Used by the related-posts strip, which hands the reader posts that are not
 * in the current results.
 */
export const useOpenBooruPost = (): ((post: LibraryAwarePost) => void) => {
  const navigate = useNavigate();
  const showAside = useShowPostInExplore(false);
  return useCallback(
    (post: LibraryAwarePost) => {
      if (post.localFileId) {
        void navigate({
          to: '/app/gallery',
          search: { fileId: post.localFileId, fs: undefined }
        });
        return;
      }
      showAside(post);
    },
    [navigate, showAside]
  );
};

/**
 * Opens a page from the pool gallery, with the pool as the sequence the
 * detail view moves through: from here the arrows and the swipe turn the
 * pool's pages, and closing returns to the pool.
 */
export const useOpenPoolPage = (): ((
  pool: { siteId: string; poolId: string; postIds: string[] },
  posts: LibraryAwarePost[],
  post: LibraryAwarePost
) => void) => {
  const showAsPlace = useShowPostInExplore(true);
  const setPoolContext = useExploreUiStore((state) => state.setPoolContext);
  return useCallback(
    (pool, posts, post) => {
      setPoolContext({ ...pool, posts });
      showAsPlace(post);
    },
    [setPoolContext, showAsPlace]
  );
};
