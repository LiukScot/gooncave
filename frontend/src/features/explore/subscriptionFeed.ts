import type { ExplorePost } from '@/api';
import { normalizeTag } from '@/features/settings/blacklist';

type SubscriptionPage = {
  posts: ExplorePost[];
  hasMore: boolean;
  nextCursor: string | null;
};

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

export const collectSubscriptionPosts = async (options: {
  cursor: string | null;
  target: number;
  maxRounds: number;
  signal: AbortSignal;
  fetchPage: (cursor: string | null) => Promise<SubscriptionPage>;
  keep: (post: ExplorePost) => boolean;
}) => {
  const posts: ExplorePost[] = [];
  let nextCursor = options.cursor;
  let hasMore = true;
  for (
    let round = 0;
    posts.length < options.target && hasMore && round < options.maxRounds;
    round += 1
  ) {
    const page = await options.fetchPage(nextCursor);
    if (options.signal.aborted) break;
    posts.push(...page.posts.filter(options.keep));
    nextCursor = page.nextCursor;
    hasMore = page.hasMore && nextCursor !== null;
  }
  return { posts, nextCursor, hasMore };
};
