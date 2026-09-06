import { Link } from '@tanstack/react-router';
import { Bell, ChevronLeft, Rss } from 'lucide-react';
import React from 'react';
import { toast } from 'sonner';

import { useExploreUiStore } from '@/stores/exploreUiStore';

/**
 * The way out of a pool, and the two controls that will one day follow it.
 *
 * Rendered twice on purpose, the way the app already handles its own
 * navigation: in the shell's header on a wide screen, so it sits on the line
 * with Explore and Gallery, and inside the pool's own title row on a phone,
 * where that header line is empty and the tab bar has the navigation. Only
 * one of the two is ever visible.
 */
export function PoolHeaderActions(): React.ReactElement {
  // Back to the grid the reader came from, at the place they left it — not
  // to the post whose navigator opened this, which is where the browser's
  // own back button leads. Explore is the fallback for a pool opened cold.
  const cameFromGallery =
    useExploreUiStore((state) => state.poolOrigin) === '/app/gallery';

  return (
    <div className="pool-head-actions">
      {/* Same square as the buttons beside it on a phone, and the same label
          rule: the words are in the accessible name either way. */}
      {cameFromGallery ? (
        <Link
          className="file-detail-back-btn file-detail-icon-button pool-head-action"
          to="/app/gallery"
          search={{ fileId: undefined, fs: undefined }}
          aria-label="Back to gallery"
          title="Back to gallery"
        >
          <ChevronLeft className="file-detail-back-icon" aria-hidden="true" />
          <span className="pool-head-action-label">Back to gallery</span>
        </Link>
      ) : (
        <Link
          className="file-detail-back-btn file-detail-icon-button pool-head-action"
          to="/app/explore"
          search={{ post: undefined }}
          aria-label="Back to explore"
          title="Back to explore"
        >
          <ChevronLeft className="file-detail-back-icon" aria-hidden="true" />
          <span className="pool-head-action-label">Back to explore</span>
        </Link>
      )}
      {/* Announced rather than hidden: both say what they will do and, for
          now, that they cannot do it yet — the same shape the Subscribed
          sort in explore uses. */}
      <button
        type="button"
        className="btn btn-outline-light btn-sm file-detail-icon-button pool-head-action"
        aria-label="Subscribe to this pool"
        title="Subscribe — coming soon"
        onClick={() => toast.info('Subscriptions are not available yet.')}
      >
        <Rss className="size-4" aria-hidden="true" />
        <span className="pool-head-action-label">Subscribe</span>
      </button>
      <button
        type="button"
        className="btn btn-outline-light btn-sm file-detail-icon-button pool-head-action"
        aria-label="Notify me about this pool"
        title="Notify — coming soon"
        onClick={() => toast.info('Notifications are not available yet.')}
      >
        <Bell className="size-4" aria-hidden="true" />
        <span className="pool-head-action-label">Notify</span>
      </button>
    </div>
  );
}
