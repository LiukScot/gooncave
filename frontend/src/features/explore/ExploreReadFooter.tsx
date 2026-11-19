import { explorePostKey } from './navSequence';

import type { ExplorePost } from '@/api';
import { WavyProgress } from '@/components/WavyProgress';
import { queueReads } from '@/features/read-marks/readQueue';

export function ExploreReadFooter({
  posts,
  hasMore,
  readHidden,
  readTrackingEnabled,
  unreadOnly,
  loading,
  onLoadMore,
  onMarkLoadedRead
}: {
  posts: Pick<ExplorePost, 'siteId' | 'remoteId'>[];
  hasMore: boolean;
  readHidden: boolean;
  readTrackingEnabled: boolean;
  unreadOnly: boolean;
  loading: boolean;
  onLoadMore: () => Promise<ExplorePost[]>;
  onMarkLoadedRead: () => void;
}) {
  if (hasMore && (posts.length > 0 || readHidden)) {
    return (
      <div className="flex justify-center mt-4">
        {loading ? (
          <WavyProgress label="Loading more posts" />
        ) : (
          <button
            type="button"
            className="btn btn-outline-light btn-sm"
            onClick={() => {
              if (readTrackingEnabled) {
                queueReads('post', posts.map(explorePostKey));
              }
              void onLoadMore();
            }}
          >
            Load more
          </button>
        )}
      </div>
    );
  }
  if (!unreadOnly || posts.length === 0) return null;
  return (
    <div className="flex justify-center mt-4">
      <button
        type="button"
        className="btn btn-outline-light btn-sm"
        disabled={loading}
        onClick={onMarkLoadedRead}
      >
        Mark as read
      </button>
    </div>
  );
}
