import { useEffect, useState } from 'react';

import { api, type ExplorePost, type PoolNavigator } from '@/api';

/**
 * The pools whatever the detail view has open is a page of.
 *
 * A pool is an ordered set — a comic, a scene — so unlike the parent/child
 * strip this answers "where am I in it, and what comes next". One request per
 * opened post, dropped when the view moves on.
 */
export type PoolTarget =
  | { kind: 'file'; fileId: string }
  | {
      kind: 'post';
      post: Pick<ExplorePost, 'siteId' | 'remoteId' | 'poolIds'>;
    };

export const usePoolNavigators = (
  target: PoolTarget
): { pools: PoolNavigator[]; loading: boolean } => {
  const [pools, setPools] = useState<PoolNavigator[]>([]);
  const [loading, setLoading] = useState(false);
  const fileId = target.kind === 'file' ? target.fileId : null;
  const post = target.kind === 'post' ? target.post : null;
  const siteId = post?.siteId ?? null;
  const remoteId = post?.remoteId ?? null;
  // Joined rather than passed as an array: a new array every render would
  // restart the effect on every render. The two "no ids" cases stay apart —
  // `poolIdsKnown` false means the booru never said, and an empty string
  // means it said "none".
  const poolIdsKnown = Boolean(post && post.poolIds !== null);
  const poolIds = post?.poolIds ? post.poolIds.join(',') : null;

  useEffect(() => {
    setPools([]);
    // An explore post whose booru already said it is in no pool: asking
    // would be a request whose answer is in hand.
    if (!fileId && poolIdsKnown && !poolIds) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const request =
      fileId !== null
        ? api.filePools(fileId, controller.signal)
        : api.explorePostPools(
            {
              siteId: siteId!,
              remoteId: remoteId!,
              poolIds: poolIdsKnown ? (poolIds ? poolIds.split(',') : []) : null
            },
            controller.signal
          );
    request
      .then((result) => {
        if (!controller.signal.aborted) setPools(result.pools);
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) {
          console.warn(`[pools] lookup failed: ${err.message}`);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [fileId, siteId, remoteId, poolIds, poolIdsKnown]);

  return { pools, loading };
};
