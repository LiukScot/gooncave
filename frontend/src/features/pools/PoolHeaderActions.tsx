import { Link } from '@tanstack/react-router';
import { ChevronLeft, Rss } from 'lucide-react';
import React from 'react';
import { toast } from 'sonner';

import {
  usePoolSubscriptionMutation,
  useSubscriptionPools
} from '@/hooks/settings';
import { type PoolOrigin, useExploreUiStore } from '@/stores/exploreUiStore';

/** Where a pool's back leads and what it says. Explore is the fallback for a pool opened cold. */
export function poolBack(origin: PoolOrigin | null) {
  switch (origin) {
    case 'gallery':
      return { label: 'Back to gallery', to: '/app/gallery', search: { fileId: undefined, fs: undefined } } as const;
    case 'subscriptions':
      return { label: 'Back to subscriptions', to: '/app/settings/subscriptions', search: {} } as const;
    case 'subscribed':
    case 'history':
      return {
        label: origin === 'subscribed' ? 'Back to subscriptions' : 'Back to history',
        to: '/app/explore',
        search: { post: undefined, feed: origin }
      } as const;
    default:
      return { label: 'Back to explore', to: '/app/explore', search: { post: undefined } } as const;
  }
}

/**
 * The way out of a pool: back to the grid the reader came from, at the place
 * they left it — not to the post whose navigator opened this, which is where
 * the browser's own back button leads.
 */
export function PoolBackButton(): React.ReactElement {
  const { label, ...back } = poolBack(useExploreUiStore((state) => state.poolOrigin));
  return (
    <Link
      className="btn btn-outline-light btn-sm file-detail-icon-button pool-head-action"
      {...back}
      aria-label={label}
      title={label}
    >
      <ChevronLeft className="size-4" aria-hidden="true" />
      <span className="pool-head-action-label">{label}</span>
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
        toast.success(`Subscribed to ${label}. New pages land in Subscriptions.`);
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
