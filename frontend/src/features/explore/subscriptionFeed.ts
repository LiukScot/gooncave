import type { ExplorePost, ExploreSort } from '@/api';
import { normalizeTag } from '@/features/settings/blacklist';

type SubscriptionPage = {
  posts: ExplorePost[];
  hasMore: boolean;
  nextCursor: string | null;
  ready?: boolean;
};

export const searchSortForTag: (sort: ExploreSort) => ExploreSort = () => 'new';

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
  subscribedTags: string[]
): string[] => {
  if (post.engine === 'furaffinity') {
    const artist = post.uploader?.replace(/^~/, '').trim();
    return artist ? [artist] : [];
  }
  const postTags = new Set(post.tags.map(({ tag }) => normalizeTag(tag)));
  return subscribedTags.filter((tag) => postTags.has(normalizeTag(tag)));
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

export const loadSubscriptionPosts = async <RefreshResult>(
  options: Parameters<typeof collectSubscriptionPosts>[0] & {
    refresh: () => Promise<RefreshResult>;
  }
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
