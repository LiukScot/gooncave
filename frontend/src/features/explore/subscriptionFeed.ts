import type { ExplorePost, ExploreSiteError, PoolSubscription } from '@/api';
import { normalizeTag } from '@/features/settings/blacklist';

type SubscriptionPage = {
  posts: ExplorePost[];
  hasMore: boolean;
  nextCursor: string | null;
  newestAt: number | null;
  siteErrors: ExploreSiteError[];
};

/** Mirrors the backend's `normalizeSubscriptionSearch`: the form searches are stored in. */
export const normalizeSubscriptionSearch = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();

export const subscriptionActionState = (
  tag: string,
  subscribedTags: string[]
): { subscribed: boolean; label: string } => {
  const normalizedTag = normalizeTag(tag);
  const alreadySubscribed = subscribedTags.some(
    (subscribedTag) => normalizeTag(subscribedTag) === normalizedTag
  );
  return alreadySubscribed
    ? { subscribed: true, label: 'Remove subscription' }
    : { subscribed: false, label: 'Subscribe' };
};

export const subscriptionReasons = (
  post: ExplorePost,
  subscribedTags: string[],
  subscribedPools: Array<Pick<PoolSubscription, 'siteId' | 'poolId' | 'name'>> = []
): string[] => {
  if (post.engine === 'furaffinity') {
    const artist = post.uploader?.replace(/^~/, '').trim();
    return artist ? [artist] : [];
  }
  const postTags = new Set(post.tags.map(({ tag }) => normalizeTag(tag)));
  const poolIds = new Set(post.poolIds ?? []);
  return [
    ...subscribedTags.filter((tag) => postTags.has(normalizeTag(tag))),
    ...subscribedPools
      .filter((pool) => pool.siteId === post.siteId && poolIds.has(pool.poolId))
      .map((pool) => pool.name)
  ];
};

/** Feed pages one load may read: a page may wait for the sites while it reads older posts. */
const MAX_PAGES_PER_LOAD = 3;

/**
 * Reads feed pages until `target` posts pass `keep`, the feed ends, or
 * MAX_PAGES_PER_LOAD pages were read. `newestAt` comes from the first page read.
 */
export const collectSubscriptionPosts = async (options: {
  cursor: string | null;
  target: number;
  signal: AbortSignal;
  fetchPage: (cursor: string | null) => Promise<SubscriptionPage>;
  keep: (post: ExplorePost) => boolean;
}) => {
  const posts: ExplorePost[] = [];
  const siteErrors: ExploreSiteError[] = [];
  let nextCursor = options.cursor;
  let newestAt: number | null = null;
  let hasMore = true;
  for (
    let pages = 0;
    pages < MAX_PAGES_PER_LOAD && posts.length < options.target && hasMore;
    pages += 1
  ) {
    let page: SubscriptionPage;
    try {
      page = await options.fetchPage(nextCursor);
    } catch (error) {
      // Posts already read stay on screen; Show more retries from the same cursor.
      if (pages === 0 || options.signal.aborted) throw error;
      siteErrors.push({
        siteId: 'subscriptions',
        siteName: 'Subscriptions',
        error: error instanceof Error ? error.message : String(error)
      });
      break;
    }
    if (options.signal.aborted) break;
    if (pages === 0) newestAt = page.newestAt;
    posts.push(...page.posts.filter(options.keep));
    siteErrors.push(...page.siteErrors);
    nextCursor = page.nextCursor;
    hasMore = page.hasMore && nextCursor !== null;
  }
  return { posts, nextCursor, newestAt, hasMore, siteErrors };
};

export type FeedDay<T> = {
  /** Local calendar day, `YYYY-MM-DD`, or null before the first dated post. */
  key: string | null;
  /** Set on the first day of each month. */
  monthLabel: string | null;
  dayLabel: string | null;
  posts: T[];
};

const localDayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/**
 * Splits a feed that is already newest first into runs of posts from the same
 * local day, as a photo timeline does. A post without a usable date stays in
 * the run it arrived in, so the feed order is never changed.
 */
export const groupFeedByDay = <T extends Pick<ExplorePost, 'createdAt'>>(
  posts: readonly T[],
  now: Date = new Date()
): FeedDay<T>[] => {
  const today = localDayKey(now);
  const yesterday = localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  // Same locale as the dates beside them, so "Yesterday" never sits over "ven 13 nov".
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const relativeDay = (days: number) => {
    const label = relative.format(days, 'day');
    return label.charAt(0).toLocaleUpperCase() + label.slice(1);
  };
  const days: FeedDay<T>[] = [];
  let month: string | null = null;
  for (const post of posts) {
    const date = post.createdAt ? new Date(post.createdAt) : null;
    const key = date && !Number.isNaN(date.getTime()) ? localDayKey(date) : null;
    const current = days.at(-1);
    if (current && (key === null || key === current.key)) {
      current.posts.push(post);
      continue;
    }
    if (!date || key === null) {
      days.push({ key: null, monthLabel: null, dayLabel: null, posts: [post] });
      continue;
    }
    const monthKey = key.slice(0, 7);
    days.push({
      key,
      monthLabel:
        monthKey === month
          ? null
          : date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      dayLabel:
        key === today
          ? relativeDay(0)
          : key === yesterday
            ? relativeDay(-1)
            : date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
      posts: [post]
    });
    month = monthKey;
  }
  return days;
};
