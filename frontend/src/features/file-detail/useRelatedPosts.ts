import { useQuery } from '@tanstack/react-query';

import { api, type ExplorePost, type RelatedPost } from '@/api';
import { queryKeys } from '@/lib/query-keys';

/**
 * The parent/child group of whatever the detail view has open: the post a
 * booru filed this one under, plus everything else filed under it.
 *
 * One request per post, dropped when the view moves on. A booru that will not
 * answer leaves the strip out rather than raising an error — the rest of the
 * page does not depend on it.
 */
export type RelatedTarget =
  | { kind: 'file'; fileId: string }
  | {
      kind: 'post';
      post: Pick<
        ExplorePost,
        'siteId' | 'remoteId' | 'parentId' | 'hasChildren'
      >;
    };

const NO_POSTS: RelatedPost[] = [];
// Asking again on every open would only repeat a request to a site that rate-limits.
const KEEP_MS = 60 * 60 * 1000;

export const useRelatedPosts = (
  target: RelatedTarget
): { posts: RelatedPost[]; loading: boolean } => {
  const post = target.kind === 'post' ? target.post : null;
  const query = useQuery({
    queryKey:
      target.kind === 'file'
        ? queryKeys.files.relations(target.fileId)
        : queryKeys.explorePostRelations(target.post.siteId, target.post.remoteId),
    queryFn: async ({ signal }) => {
      try {
        const { posts } =
          target.kind === 'file'
            ? await api.fileRelations(target.fileId, signal)
            : await api.exploreRelations(target.post, signal);
        return posts;
      } catch (error) {
        if (!signal.aborted) console.warn(`[relations] lookup failed: ${(error as Error).message}`);
        throw error;
      }
    },
    // A post the booru says is neither a child nor a parent has no group,
    // and asking for one would be a request whose answer is known.
    enabled: !post || Boolean(post.parentId) || post.hasChildren,
    retry: false,
    staleTime: KEEP_MS,
    gcTime: KEEP_MS
  });
  return { posts: query.data ?? NO_POSTS, loading: query.isFetching };
};
