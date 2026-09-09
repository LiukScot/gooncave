import type { ExplorePost } from '@/api';

/** Identity of a post across sites: two boorus reuse the same numbers. */
export const explorePostKey = (post: ExplorePost): string =>
  `${post.siteId}:${post.remoteId}`;

/**
 * Where the arrows, Prev/Next and a swipe move within the sequence the reader
 * opened — the search results, or a pool when one was opened as a gallery.
 *
 * The cursor is the *anchor*, never the open post. A post reached as an
 * excursion — a pool navigator's Prev/Next, a related post — must not drag
 * the cursor along, so stepping right from one lands beside where the reader
 * actually was, and the place they left in the gallery stays where they left
 * it however far the excursion wandered.
 *
 * The open post is only a fallback for having no anchor at all, which is the
 * first post of a session, opened straight from a link. Reading the open
 * post's own position whenever it happens to sit in the sequence is what this
 * must not do: the pages of a comic are usually results in their own right,
 * and the cursor would then follow every page turned.
 */
export const anchorIndexOf = (
  navKeys: readonly string[],
  selectedKey: string | null,
  anchorKey: string | null
): number => {
  const anchored = anchorKey ? navKeys.indexOf(anchorKey) : -1;
  if (anchored >= 0) return anchored;
  return selectedKey ? navKeys.indexOf(selectedKey) : -1;
};

export type RelativeStep = number | 'load-next' | null;

/** The loaded index to open, or the request needed to move past its edge. */
export const relativeStep = (
  currentIndex: number,
  delta: number,
  loadedLength: number,
  hasMore: boolean
): RelativeStep => {
  const targetIndex = currentIndex + delta;
  if (targetIndex < 0) return null;
  if (targetIndex < loadedLength) return targetIndex;
  return delta > 0 && hasMore ? 'load-next' : null;
};
