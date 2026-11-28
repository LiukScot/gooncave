import { explorePostKey } from './navSequence';

import type { ExplorePost } from '@/api';

const canonicalUrl = (raw: string): string | null => {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^(www|sfw)\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    const fa = /^\/(?:view|full)\/(\d+)$/i.exec(path);
    if (host === 'furaffinity.net' && fa) return `furaffinity.net/view/${fa[1]}`;
    return `${host}${path}${url.search}`;
  } catch {
    return null;
  }
};

const linksTo = (source: ExplorePost, target: ExplorePost): boolean => {
  const targetUrl = canonicalUrl(target.sourceUrl);
  return targetUrl !== null &&
    (source.sourceUrls ?? []).some((url) => canonicalUrl(url) === targetUrl);
};

const visuallySame = (left: ExplorePost, right: ExplorePost): boolean =>
  Boolean(
    left.sameLookAs?.includes(explorePostKey(right)) ||
    right.sameLookAs?.includes(explorePostKey(left))
  );

const sameImage = (a: ExplorePost, b: ExplorePost): boolean =>
  (a.siteId !== b.siteId || a.remoteId !== b.remoteId) &&
  ((Boolean(a.md5) && a.md5?.toLowerCase() === b.md5?.toLowerCase()) ||
    linksTo(a, b) || linksTo(b, a) || visuallySame(a, b));

/**
 * Keep the first tile in place when a matching copy arrives later. `stacks`
 * may hold the stacks of earlier posts; they are extended in place.
 */
export function stackDuplicates(
  posts: ExplorePost[],
  stacks: ExplorePost[][] = []
): ExplorePost[][] {
  for (const post of posts) {
    const stack = stacks.find((candidate) =>
      candidate.some((member) => sameImage(member, post))
    );
    if (stack) {
      stack.push(post);
    } else {
      stacks.push([post]);
    }
  }
  return stacks;
}
