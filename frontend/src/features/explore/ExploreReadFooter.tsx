import { explorePostKey } from './navSequence';

import type { ExplorePost } from '@/api';
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
        <button
          type="button"
          className="btn btn-outline-light btn-sm"
          onClick={() => {
            if (readTrackingEnabled) {
              queueReads('post', posts.map(explorePostKey));
            }
            void onLoadMore();
          }}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
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
