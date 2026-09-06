import { Link, useLocation } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import React, { useState } from 'react';

import { api, type PoolNavigator } from '@/api';
import { useOpenExcursionPost } from '@/features/explore/useOpenBooruPost';
import { useExploreUiStore } from '@/stores/exploreUiStore';

/**
 * Where the open post sits inside each pool it belongs to, and the way out
 * on either side — the block e621 puts above a post, one row per pool.
 *
 * Nothing is rendered for a post in no pool, which is most of them.
 */
export function PoolNavigators({
  pools
}: {
  pools: readonly PoolNavigator[];
}): React.ReactElement | null {
  const showPost = useOpenExcursionPost();
  const pathname = useLocation({ select: (state) => state.pathname });
  const setPoolOrigin = useExploreUiStore((state) => state.setPoolOrigin);
  // The neighbouring page is read on demand, so the button says it is busy
  // rather than looking ignored for the length of one booru request.
  const [pendingId, setPendingId] = useState<string | null>(null);

  const step = async (siteId: string, remoteId: string) => {
    setPendingId(remoteId);
    try {
      const { post } = await api.explorePost(siteId, remoteId);
      showPost(post);
    } catch (err) {
      console.warn(
        `[pools] could not open ${remoteId}: ${(err as Error).message}`
      );
    } finally {
      setPendingId(null);
    }
  };

  // No placeholder while loading: a post is usually in no pool at all, and a
  // box that appeared and vanished again would read as a glitch.
  if (!pools.length) return null;
  return (
    <>
      <div className="pool-nav-list mb-4">
        {pools.map((pool) => (
          <div className="pool-nav" key={`${pool.siteId}:${pool.poolId}`}>
            <button
              type="button"
              className="pool-nav-step"
              disabled={!pool.prevId || pendingId !== null}
              onClick={() => pool.prevId && void step(pool.siteId, pool.prevId)}
              aria-label={`Previous page of ${pool.name}`}
              title={
                pool.prevId
                  ? `Page ${pool.position - 1} of ${pool.name}`
                  : 'First page of this pool'
              }
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              Prev
            </button>
            <Link
              className="pool-nav-name"
              to="/app/pool"
              search={{ site: pool.siteId, pool: pool.poolId }}
              title={`Open ${pool.name} on ${pool.siteName}`}
              onClick={() => setPoolOrigin(pathname)}
            >
              <span className="pool-nav-title">{pool.name}</span>
              <span className="pool-nav-count">
                {pool.position} / {pool.postCount}
              </span>
            </Link>
            <button
              type="button"
              className="pool-nav-step"
              disabled={!pool.nextId || pendingId !== null}
              onClick={() => pool.nextId && void step(pool.siteId, pool.nextId)}
              aria-label={`Next page of ${pool.name}`}
              title={
                pool.nextId
                  ? `Page ${pool.position + 1} of ${pool.name}`
                  : 'Last page of this pool'
              }
            >
              Next
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      {/* Closes the block off from the info section below it, the way every
          other section here is separated. Only reached when there is a pool,
          so a plain post keeps its unbroken top. */}
      <div className="file-detail-section-divider" />
    </>
  );
}
