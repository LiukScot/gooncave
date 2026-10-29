import { useEffect } from 'react';
import { toast, type ExternalToast } from 'sonner';

/**
 * Shows an error as a toast when it appears, so the page does not move. `error` is whatever
 * changes on each failure: an Error, a message, or nothing. A message that stays the same
 * is not shown twice until it has gone away and come back.
 */
export function useErrorToast(
  error: Error | string | null | undefined,
  options?: ExternalToast
): void {
  useEffect(() => {
    if (!error) return;
    toast.error(typeof error === 'string' ? error : error.message, options);
    // The toast is per failure; a new options object on every render must not repeat it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);
}
