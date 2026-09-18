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

const visuallySame = (left: ExplorePost, right: ExplorePost): boolean => {
  const sameSite = left.siteId === right.siteId;
  if (sameSite && (!left.uploader || !right.uploader ||
      left.uploader.toLowerCase() === right.uploader.toLowerCase()))
    return false;
  const a = left.visualSignature;
  const b = right.visualSignature;
  if (!a || !b || a.length !== 768 || b.length !== 768) return false;
  if (!left.width || !left.height || !right.width || !right.height) return false;
  const ratioA = left.width / left.height;
  const ratioB = right.width / right.height;
  if (Math.abs(ratioA / ratioB - 1) > 0.03) return false;
  let total = 0;
  let largeDifferences = 0;
  for (let i = 0; i < a.length; i++) {
    const difference = Math.abs(a[i] - b[i]);
    total += difference;
    if (difference > 50) largeDifferences++;
  }
  return total / a.length <= (sameSite ? 6 : 10) &&
    largeDifferences / a.length <= (sameSite ? 0.02 : 0.05);
};

const sameImage = (a: ExplorePost, b: ExplorePost): boolean =>
  (a.siteId !== b.siteId || a.remoteId !== b.remoteId) &&
  ((Boolean(a.md5) && a.md5?.toLowerCase() === b.md5?.toLowerCase()) ||
    linksTo(a, b) || linksTo(b, a) || visuallySame(a, b));

/** Keep the first tile in place when a matching copy arrives later. */
export function stackDuplicates(posts: ExplorePost[]): ExplorePost[][] {
  const stacks: ExplorePost[][] = [];
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
