import { useQuery } from '@tanstack/react-query';

import { api, type ExploreComment, type ExplorePost } from '@/api';
import { FoldedBox } from '@/components/FoldedBox';
import { MarkdownText } from '@/features/file-detail/MarkdownText';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';

const STALE_MS = 60 * 60 * 1000;

type CommentList = { supported: boolean; comments: ExploreComment[] };

/** The comments of one post in explore. */
export function ExploreComments({
  post
}: {
  post: Pick<ExplorePost, 'siteId' | 'remoteId'>;
}) {
  return (
    <CommentsSection
      key={`${post.siteId}:${post.remoteId}`}
      queryKey={queryKeys.explorePostComments(post.siteId, post.remoteId)}
      load={() => api.explorePostComments(post.siteId, post.remoteId)}
    />
  );
}

/** The comments of the post a library file was saved from. */
export function FileComments({ fileId }: { fileId: string }) {
  return (
    <CommentsSection
      key={fileId}
      queryKey={queryKeys.files.comments(fileId)}
      load={() => api.fileComments(fileId)}
    />
  );
}

/**
 * Comments as the last section of a detail view. A post with none, a site
 * that publishes none, and the wait for the answer show nothing at all.
 */
function CommentsSection({
  queryKey,
  load
}: {
  queryKey: readonly unknown[];
  load: () => Promise<CommentList>;
}) {
  const query = useQuery({ queryKey, queryFn: load, staleTime: STALE_MS });
  if (query.data && !query.data.supported) return null;

  const comments = query.data?.comments ?? [];
  if (!query.isError && comments.length === 0) return null;

  return (
    <>
      <div className="file-detail-section-divider" />
      <div className="file-detail-section mb-4" data-test-id="explore-comments">
        <div className="file-detail-section-head">
          <div className="uppercase font-semibold file-detail-section-title">
            Comments{comments.length > 0 ? ` (${comments.length})` : ''}
          </div>
        </div>
        {query.isError ? (
          <div className="flex items-center gap-3">
            <span className="text-destructive text-sm" role="alert">
              Comments failed to load: {query.error.message}
            </span>
            <button
              type="button"
              className="btn btn-outline-light btn-sm"
              onClick={() => void query.refetch()}
            >
              Retry
            </button>
          </div>
        ) : (
          <FoldedBox maxHeight="24rem">
            {comments.map((comment) => (
              <article key={comment.id} className="file-detail-comment">
                <div className="file-detail-comment-head text-sm">
                  <span className="font-semibold">{comment.author}</span>
                  <span className="text-muted-foreground">
                    {formatDateTime(comment.createdAt)}
                  </span>
                  {comment.score !== null ? (
                    <span className="text-muted-foreground">
                      Score {comment.score}
                    </span>
                  ) : null}
                </div>
                <div className="file-detail-source-text text-muted-foreground text-sm">
                  <MarkdownText text={comment.body} />
                </div>
              </article>
            ))}
          </FoldedBox>
        )}
      </div>
    </>
  );
}
