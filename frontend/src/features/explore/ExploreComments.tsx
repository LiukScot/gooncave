import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api, type ExploreComment, type ExplorePost } from '@/api';
import { MarkdownText } from '@/features/file-detail/MarkdownText';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';

const STALE_MS = 60 * 60 * 1000;
// Past this the rest waits behind a button, so a long thread does not push
// the page's end out of reach.
const SHOWN_AT_FIRST = 20;

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
 * Comments as the last section of a detail view. Sites that publish none
 * show nothing at all.
 */
function CommentsSection({
  queryKey,
  load
}: {
  queryKey: readonly unknown[];
  load: () => Promise<CommentList>;
}) {
  const [showAll, setShowAll] = useState(false);
  const query = useQuery({ queryKey, queryFn: load, staleTime: STALE_MS });
  if (query.data && !query.data.supported) return null;

  const comments = query.data?.comments ?? [];
  const shown = showAll ? comments : comments.slice(0, SHOWN_AT_FIRST);

  return (
    <>
      <div className="file-detail-section-divider" />
      <div className="file-detail-section mb-4" data-test-id="explore-comments">
        <div className="file-detail-section-head">
          <div className="uppercase font-semibold file-detail-section-title">
            Comments{comments.length > 0 ? ` (${comments.length})` : ''}
          </div>
        </div>
        {query.isPending ? (
          <span className="text-muted-foreground text-sm" role="status">
            Loading comments…
          </span>
        ) : query.isError ? (
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
        ) : comments.length === 0 ? (
          <span className="text-muted-foreground text-sm">No comments yet.</span>
        ) : (
          <>
            {shown.map((comment) => (
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
            {comments.length > shown.length ? (
              <button
                type="button"
                className="btn btn-link btn-sm mt-1"
                onClick={() => setShowAll(true)}
              >
                Show all {comments.length} comments
              </button>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
