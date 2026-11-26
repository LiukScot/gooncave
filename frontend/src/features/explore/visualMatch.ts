import { galleryMatchBatches } from './automaticDuplicateFavorites';
import { explorePostKey } from './navSequence';

import { api, type ExplorePost } from '@/api';
import { logDeveloper } from '@/lib/windowErrorLog';

/** The core accepts no more loaded posts than this in one request. */
const MAX_EARLIER = 5000;

/**
 * Marks the posts that show the picture of another post of `posts` or of
 * `earlier`, the posts already in the grid, before they enter it.
 */
export async function withVisualMatches(
  posts: ExplorePost[],
  earlier: ExplorePost[],
  signal: AbortSignal
): Promise<ExplorePost[]> {
  const same = new Map<string, string[]>();
  try {
    let shown = earlier.slice(-MAX_EARLIER);
    for (const batch of galleryMatchBatches(posts)) {
      const { copies } = await api.exploreCopies(batch, shown, signal);
      for (const [key, other] of copies) {
        same.set(key, [...(same.get(key) ?? []), other]);
      }
      shown = [...shown, ...batch].slice(-MAX_EARLIER);
    }
  } catch (error) {
    if (!signal.aborted) {
      logDeveloper(
        `Copies were not looked for among ${posts.length} loaded posts: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return posts.map((post) => {
    const sameLookAs = same.get(explorePostKey(post));
    return sameLookAs ? { ...post, sameLookAs } : post;
  });
}
