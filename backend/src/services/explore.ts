import { readMarksRepo } from '../db/repos/readMarksRepo';
import type { ExploreSort, RemotePost } from '../lib/booruEngines';

export type ExplorePost = Omit<RemotePost, 'favorited'> & {
  /** Resolved by the route: the booru's answer, or what the library holds. */
  favorited: boolean;
  siteId: string;
  siteName: string;
  engine: string;
  sourceUrl: string;
  /** Already shown to this user, so the Unread only filter can drop it. */
  read: boolean;
};

/**
 * How a remote post is identified outside its own booru. Remote posts have no
 * row anywhere, so read marks key them by site and id; the frontend builds the
 * same string in explorePostKey.
 */
export const explorePostKey = (post: { siteId: string; remoteId: string }) =>
  `${post.siteId}:${post.remoteId}`;

/** Fills in `read` for a page of posts with one query. */
export const markReadPosts = <T extends { siteId: string; remoteId: string }>(
  userId: string,
  posts: T[]
): (T & { read: boolean })[] => {
  const readKeys = readMarksRepo.listReadKeys(
    userId,
    'post',
    posts.map(explorePostKey)
  );
  return posts.map((post) => ({
    ...post,
    read: readKeys.has(explorePostKey(post))
  }));
};

/**
 * Merges per-site result pages into one list. Posts sharing an md5 are
 * deduplicated keeping the first occurrence (input order = the user's site
 * sort order). 'new' orders by createdAt desc (unknown dates sink last);
 * other sorts order by raw score desc.
 */
export const mergeExplorePosts = <
  T extends Pick<ExplorePost, 'md5' | 'score' | 'createdAt'>
>(
  bySite: T[][],
  sort: ExploreSort
): T[] => {
  const merged: T[] = [];
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
