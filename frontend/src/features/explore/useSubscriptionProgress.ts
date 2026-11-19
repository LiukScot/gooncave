import { useEffect, useState } from 'react';

import { api } from '@/api';

/** How often a Subscriptions feed waiting for its first page asks how far the sync got. */
export const PROGRESS_CHECK_MS = 500;

export type SubscriptionProgress = { read: number; total: number };

/**
 * The searches the running Subscriptions sync has read, asked every half second while
 * `active`. `null` until a sync reports, and again once `active` turns off.
 */
export function useSubscriptionProgress(active: boolean): SubscriptionProgress | null {
  const [progress, setProgress] = useState<SubscriptionProgress | null>(null);
  useEffect(() => {
    setProgress(null);
    if (!active) return;
    const controller = new AbortController();
    const check = () => {
      api
        .subscriptionProgress(controller.signal)
        .then(({ read, total }) => {
          if (controller.signal.aborted) return;
          setProgress(read === null || total === null ? null : { read, total });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          console.error('[developer] Cannot read the subscriptions sync progress:', error);
        });
    };
    check();
    const timer = window.setInterval(check, PROGRESS_CHECK_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [active]);
  return progress;
}
