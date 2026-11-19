import { useEffect, useState } from 'react';

import { api } from '@/api';

/** How often an open Subscriptions feed asks whether a sync saved newer posts. */
export const NEW_POSTS_CHECK_MS = 30_000;

/**
 * How many posts a sync saved above `newestAt`, the newest post shown: the sync started when
 * the feed opened, or the one every 15 minutes. They are offered on request, never inserted
 * above the reader. Asks again every 30 seconds while the page is visible, and when it becomes
 * visible. `null` stops asking.
 */
export function useNewSubscriptionPosts(
  newestAt: number | null,
  siteIds: string[],
  unread: boolean
): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(0);
    if (newestAt === null) return;
    const controller = new AbortController();
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      api
        .newSubscriptionPosts({ siteIds, after: newestAt, unread, signal: controller.signal })
        .then(({ count: found }) => {
          if (!controller.signal.aborted) setCount(found);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          console.error('[developer] Cannot count new subscription posts:', error);
        });
    };
    const timer = window.setInterval(check, NEW_POSTS_CHECK_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      controller.abort();
    };
  }, [newestAt, siteIds, unread]);
  return count;
}
