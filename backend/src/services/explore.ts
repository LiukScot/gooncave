import type { ExploreSort, RemotePost } from '../lib/booruEngines';

export type ExplorePost = Omit<RemotePost, 'favorited'> & {
  /** Resolved by the route: the booru's answer, or what the library holds. */
  favorited: boolean;
  siteId: string;
  siteName: string;
  engine: string;
  sourceUrl: string;
};

/**
 * Merges per-site result pages into one list. Posts sharing an md5 are
 * deduplicated keeping the first occurrence (input order = the user's site
 * sort order). 'new' orders by createdAt desc (unknown dates sink last);
 * other sorts order by raw score desc.
 */
export const mergeExplorePosts = (
  bySite: ExplorePost[][],
  sort: ExploreSort
): ExplorePost[] => {
  const merged: ExplorePost[] = [];
  const seenMd5 = new Set<string>();
  for (const posts of bySite) {
    for (const post of posts) {
      if (post.md5) {
        if (seenMd5.has(post.md5)) continue;
        seenMd5.add(post.md5);
      }
      merged.push(post);
    }
  }
  if (sort === 'new') {
    merged.sort(
      (a, b) =>
        (b.createdAt ? Date.parse(b.createdAt) : 0) -
        (a.createdAt ? Date.parse(a.createdAt) : 0)
    );
  } else {
    // ponytail: raw score comparison across sites (no normalisation); good
    // enough until per-site score scales prove distracting in practice.
    merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
  return merged;
};
