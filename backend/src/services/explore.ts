import { readMarksRepo } from '../db/repos/readMarksRepo';
import type { ExploreSort, RemotePost } from '../lib/booruEngines';

export type ExplorePost = Omit<RemotePost, 'favorited'> & {
  /** Resolved by the route: the booru's answer, or what the library holds. */
  favorited: boolean;
  siteId: string;
  siteName: string;
  engine: string;
  sourceUrl: string;
  /** Same-origin signed preview used only for optional visual matching. */
  matchPreviewUrl?: string | null;
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
 * Merges per-site result pages into one list. 'new' keeps each site's own
 * order and alternates sites; other sorts order by raw score desc.
 */
export const mergeExplorePosts = <T extends Pick<ExplorePost, 'score'>>(
  bySite: T[][],
  sort: ExploreSort
): T[] => {
  const merged: T[] = [];
  const sitePosts: T[][] = bySite.map(() => []);
  bySite.forEach((posts, siteIndex) => {
    for (const post of posts) {
      merged.push(post);
      sitePosts[siteIndex].push(post);
    }
  });
  if (sort === 'new') {
    const siteIndexes = bySite.map(() => 0);
    const interleaved: T[] = [];
    while (interleaved.length < merged.length) {
      sitePosts.forEach((posts, siteIndex) => {
        const next = posts[siteIndexes[siteIndex]];
        if (next) interleaved.push(next);
        siteIndexes[siteIndex] += 1;
      });
    }
    return interleaved;
  } else {
    // ponytail: raw score comparison across sites (no normalisation); good
    // enough until per-site score scales prove distracting in practice.
    merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
  return merged;
};
