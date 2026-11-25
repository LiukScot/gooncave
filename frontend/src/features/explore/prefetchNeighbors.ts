import type { QueryClient } from '@tanstack/react-query';

import { api, type ExplorePost } from '@/api';
import { loadExplorePostDetails } from '@/features/explore/explorePostDetails';
import { queryKeys } from '@/lib/query-keys';

/**
 * Whether the open post asks its site for tags. A gelbooru-engine site (Rule34) sends every tag
 * as general and only its page has the categories; the core fills the ones its vocabulary knows,
 * so a few categorised tags do not mean the page was read.
 */
export const needsDetailTags = (post: Pick<ExplorePost, 'tags' | 'engine'>): boolean =>
  post.engine === 'gelbooru' ||
  post.tags.length === 0 ||
  post.tags.every((entry) => entry.category === 'general');

/**
 * Asks for what the previous and next post will show, so stepping to one finds its tags,
 * description and related posts already loaded. Fire and forget: the open post never waits.
 */
export function prefetchNeighbors(
  queryClient: QueryClient,
  neighbors: readonly (ExplorePost | null)[]
): void {
  for (const post of neighbors) {
    if (!post) continue;
    if (needsDetailTags(post)) {
      loadExplorePostDetails(post).catch((error: unknown) => {
        console.warn(`[developer] Preloading the tags of a nearby post failed: ${String(error)}`);
      });
    }
    if (post.description === undefined) {
      void queryClient.prefetchQuery({
        queryKey: queryKeys.explorePostText(post.siteId, post.remoteId),
        queryFn: () => api.explorePostText(post.siteId, post.remoteId),
        // Asks only for what is not loaded; the open post's own query decides when to refresh.
        staleTime: Infinity
      });
    }
    if (post.parentId || post.hasChildren) {
      void queryClient.prefetchQuery({
        queryKey: queryKeys.explorePostRelations(post.siteId, post.remoteId),
        queryFn: async ({ signal }) => (await api.exploreRelations(post, signal)).posts,
        staleTime: Infinity
      });
    }
  }
}
