import { useEffect, useState } from 'react';

import { api, type ExplorePost, type RelatedPost } from '@/api';

/**
 * The parent/child group of whatever the detail view has open: the post a
 * booru filed this one under, plus everything else filed under it.
 *
 * One request per opened post, dropped when the view moves on. A booru that
 * will not answer leaves the strip out rather than raising an error — the
 * rest of the page does not depend on it.
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

export const useRelatedPosts = (
  target: RelatedTarget
): { posts: RelatedPost[]; loading: boolean } => {
  const [posts, setPosts] = useState<RelatedPost[]>([]);
  const [loading, setLoading] = useState(false);
  const fileId = target.kind === 'file' ? target.fileId : null;
  const post = target.kind === 'post' ? target.post : null;
  const siteId = post?.siteId ?? null;
  const remoteId = post?.remoteId ?? null;
  const parentId = post?.parentId ?? null;
  const hasChildren = post?.hasChildren ?? false;

  useEffect(() => {
    setPosts([]);
    // A post the booru says is neither a child nor a parent has no group,
    // and asking for one would be a request whose answer is known.
    if (!fileId && !parentId && !hasChildren) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const request =
      fileId !== null
        ? api.fileRelations(fileId, controller.signal)
        : api.exploreRelations(
            { siteId: siteId!, remoteId: remoteId!, parentId, hasChildren },
            controller.signal
          );
    request
      .then((result) => {
        if (!controller.signal.aborted) setPosts(result.posts);
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) {
          console.warn(`[relations] lookup failed: ${err.message}`);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [fileId, siteId, remoteId, parentId, hasChildren]);

  return { posts, loading };
};
