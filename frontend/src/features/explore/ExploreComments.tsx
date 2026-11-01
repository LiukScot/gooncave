import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { api, type ExplorePost, type FileCommentSource } from '@/api';
import { FoldedBox } from '@/components/FoldedBox';
import { MarkdownText } from '@/features/file-detail/MarkdownText';
import { SourcePicks } from '@/features/file-detail/SourceTextSection';
import { formatDateTime } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { queryKeys } from '@/lib/query-keys';

const STALE_MS = 60 * 60 * 1000;
const NEAR_SCREEN = '600px';

type CommentList = { supported: boolean; sources: FileCommentSource[] };
type CommentsProps = {
  queryKey: readonly unknown[];
  load: () => Promise<CommentList>;
};

/** The comments of one post in explore. */
export function ExploreComments({
  post
}: {
  post: Pick<ExplorePost, 'siteId' | 'remoteId' | 'siteName' | 'sourceUrl' | 'commentCount'>;
}) {
  if (post.commentCount === 0) return null;
  return (
    <CommentsSection
      key={`${post.siteId}:${post.remoteId}`}
      queryKey={queryKeys.explorePostComments(post.siteId, post.remoteId)}
      load={async () => {
        const { supported, comments } = await api.explorePostComments(post.siteId, post.remoteId);
        return { supported, sources: [{ siteName: post.siteName, sourceUrl: post.sourceUrl, comments }] };
      }}
    />
  );
}

/** The comments of the posts a library file was saved from. */
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
 *
 * Asked for only near the screen: a booru answers one request at a time, so
 * comments asked for on opening make the description, pool and parents above
 * them wait.
 */
function CommentsSection(props: CommentsProps) {
  const [near, setNear] = useState(false);
  const markerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const marker = markerRef.current;
    if (near || !marker) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: NEAR_SCREEN }
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [near]);

  return (
    <>
      <div ref={markerRef} />
      {near ? <LoadedComments {...props} /> : null}
    </>
  );
}

function LoadedComments({ queryKey, load }: CommentsProps) {
  const query = useQuery({ queryKey, queryFn: load, staleTime: STALE_MS });
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const online = useOnline();
  if (query.data && !query.data.supported) return null;

  const sources = (query.data?.sources ?? []).filter((source) => source.comments.length > 0);
  const selected = sources.find((source) => source.sourceUrl === selectedUrl) ?? sources.at(0);
  const comments = selected?.comments ?? [];
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
        {query.isError && !online ? (
          <p className="text-muted-foreground text-sm" role="status">
            Comments come from the site, so they load when you reconnect.
          </p>
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
        ) : (
          <>
            {selected ? (
              <SourcePicks
                sources={sources}
                selected={selected}
                onSelect={(source) => setSelectedUrl(source.sourceUrl)}
                label="Comments source"
              />
            ) : null}
            <FoldedBox key={selected?.sourceUrl} maxHeight="24rem">
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
          </>
        )}
      </div>
    </>
  );
}
