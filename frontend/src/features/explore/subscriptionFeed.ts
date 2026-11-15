import type { ExplorePost, PoolSubscription } from '@/api';
import { normalizeTag } from '@/features/settings/blacklist';

type SubscriptionPage = {
  posts: ExplorePost[];
  hasMore: boolean;
  nextCursor: string | null;
  ready?: boolean;
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

/** The username behind an artist tag of a FurAffinity post: there it can only be who posted it. */
export const furAffinityArtist = (
  post: Pick<ExplorePost, 'engine' | 'tags' | 'uploader'>,
  tag: string
): string | undefined => {
  if (post.engine !== 'furaffinity') return undefined;
  const isArtist = post.tags.some(
    (entry) => entry.category === 'artist' && normalizeTag(entry.tag) === normalizeTag(tag)
  );
  const uploader = post.uploader?.replace(/^~/, '').trim().toLowerCase();
  return isArtist && uploader ? uploader : undefined;
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

export const collectSubscriptionPosts = async (options: {
  cursor: string | null;
  target: number;
  signal: AbortSignal;
  fetchPage: (cursor: string | null) => Promise<SubscriptionPage>;
  keep: (post: ExplorePost) => boolean;
  stopWhenNotReady?: boolean;
}) => {
  const posts: ExplorePost[] = [];
  let nextCursor = options.cursor;
  let hasMore = true;
  const visitedCursors = new Set<string | null>();
  while (
    posts.length < options.target &&
    hasMore &&
    !visitedCursors.has(nextCursor)
  ) {
    visitedCursors.add(nextCursor);
    const page = await options.fetchPage(nextCursor);
    if (options.signal.aborted) break;
    if (options.stopWhenNotReady && page.ready === false) break;
    posts.push(...page.posts.filter(options.keep));
    nextCursor = page.nextCursor;
    hasMore = page.hasMore && nextCursor !== null;
  }
  return { posts, nextCursor, hasMore };
};

type LoadOptions<RefreshResult> = Parameters<typeof collectSubscriptionPosts>[0] & {
  refresh: () => Promise<RefreshResult>;
};

/** How many saved-feed reads, each with its backfill, one load may chain. */
const MAX_LOADS = 3;

/**
 * Reads the next posts, backfilling from the sites where the saved feed ends.
 * Below `minPosts` kept posts it reads on, up to MAX_LOADS times: with most
 * posts already read, one backfill can end with a single post on screen.
 */
export const loadSubscriptionPosts = async <RefreshResult>(
  options: LoadOptions<RefreshResult> & { minPosts?: number }
) => {
  let result = await loadSubscriptionPostsOnce(options);
  const posts = [...result.posts];
  let refreshError = result.refreshError;
  for (
    let load = 1;
    load < MAX_LOADS &&
    posts.length < (options.minPosts ?? 0) &&
    result.hasMore &&
    result.nextCursor !== null &&
    !options.signal.aborted;
    load += 1
  ) {
    result = await loadSubscriptionPostsOnce({
      ...options,
      cursor: result.nextCursor,
      target: options.target - posts.length
    });
    posts.push(...result.posts);
    refreshError ??= result.refreshError;
  }
  return { ...result, posts, refreshError };
};

const loadSubscriptionPostsOnce = async <RefreshResult>(
  options: LoadOptions<RefreshResult>
) => {
  const probe = await options.fetchPage(options.cursor);
  const collectFromProbe = (stopWhenNotReady: boolean) => {
    let firstPage: SubscriptionPage | null = probe;
    return collectSubscriptionPosts({
      ...options,
      stopWhenNotReady,
      fetchPage: async (cursor) => {
        if (!firstPage) return options.fetchPage(cursor);
        const current = firstPage;
        firstPage = null;
        return current;
      }
    });
  };
  if (probe.ready !== false) {
    return {
      ...(await collectFromProbe(true)),
      refreshed: null,
      refreshError: null
    };
  }
  let refreshed: RefreshResult;
  try {
    refreshed = await options.refresh();
  } catch (error: unknown) {
    return {
      ...(await collectFromProbe(false)),
      refreshed: null,
      refreshError: error
    };
  }
  const page = await collectSubscriptionPosts({
    ...options,
    stopWhenNotReady: true
  });
  return { ...page, refreshed, refreshError: null };
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
