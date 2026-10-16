import { Link } from '@tanstack/react-router';
import { ChevronLeft, Rss } from 'lucide-react';
import React from 'react';
import { toast } from 'sonner';

import {
  usePoolSubscriptionMutation,
  useSubscriptionPools
} from '@/hooks/settings';
import { useExploreUiStore } from '@/stores/exploreUiStore';

/**
 * The way out of a pool: back to the grid the reader came from, at the place
 * they left it — not to the post whose navigator opened this, which is where
 * the browser's own back button leads. Explore is the fallback for a pool
 * opened cold.
 */
export function PoolBackButton(): React.ReactElement {
  const cameFromGallery =
    useExploreUiStore((state) => state.poolOrigin) === '/app/gallery';
  return cameFromGallery ? (
    <Link
      className="btn btn-outline-light btn-sm file-detail-icon-button pool-head-action"
      to="/app/gallery"
      search={{ fileId: undefined, fs: undefined }}
      aria-label="Back to gallery"
      title="Back to gallery"
    >
      <ChevronLeft className="size-4" aria-hidden="true" />
      <span className="pool-head-action-label">Back to gallery</span>
    </Link>
  ) : (
    <Link
      className="btn btn-outline-light btn-sm file-detail-icon-button pool-head-action"
      to="/app/explore"
      search={{ post: undefined }}
      aria-label="Back to explore"
      title="Back to explore"
    >
      <ChevronLeft className="size-4" aria-hidden="true" />
      <span className="pool-head-action-label">Back to explore</span>
    </Link>
  );
}

export function PoolHeaderActions({
  site,
  pool,
  name
}: {
  site: string;
  pool: string;
  name: string | undefined;
}): React.ReactElement {
  const pools = useSubscriptionPools();
  const subscribed =
    pools.data?.pools.some((p) => p.siteId === site && p.poolId === pool) ??
    false;
  const follow = usePoolSubscriptionMutation(true);
  const unfollow = usePoolSubscriptionMutation(false);
  const pending = follow.isPending || unfollow.isPending;
  const label = name ?? 'this pool';

  const toggle = async () => {
    try {
      if (subscribed) {
        await unfollow.mutateAsync({ siteId: site, poolId: pool });
        toast.success(`Unsubscribed from ${label}`);
      } else {
        await follow.mutateAsync({ siteId: site, poolId: pool });
        toast.success(`Subscribed to ${label}. New pages land in Subscribed.`);
      }
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <div className="pool-head-actions">
      <button
        type="button"
        className={`btn btn-sm file-detail-icon-button pool-head-action ${
          subscribed ? 'btn-primary' : 'btn-outline-light'
        }`}
        aria-label={subscribed ? 'Unsubscribe from this pool' : 'Subscribe to this pool'}
        aria-pressed={subscribed}
        title={subscribed ? 'Subscribed' : 'Subscribe'}
        disabled={!pools.isSuccess || pending}
        onClick={() => void toggle()}
      >
        <Rss className="size-4" aria-hidden="true" />
        <span className="pool-head-action-label">
          {subscribed ? 'Subscribed' : 'Subscribe'}
        </span>
      </button>
    </div>
  );
}
