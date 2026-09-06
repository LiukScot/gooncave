import { useCallback, useEffect, useRef } from 'react';

import { restoreScrollTo } from './restoreScrollTo';

/**
 * Sends the page to the top when a detail view opens, and back to where the
 * list was when it closes.
 *
 * Shared by the gallery and by explore: both unmount their grid while the
 * detail is up, so returning would otherwise land at the top of a freshly
 * mounted page.
 *
 * `openKey` identifies what is open (null when nothing is). The returned
 * `remember` records the current offset and must be called by whoever opens
 * from the list — and only them. Opening cannot infer it: prev/next and the
 * URL sync both re-open while the window is already pinned to the top of the
 * detail view, and the URL sync can do so right after a transient
 * deselection, which would read as a fresh list open and save 0.
 */
export function useDetailScrollRestore(openKey: string | null): () => void {
  const savedScrollRef = useRef(0);
  /**
   * Whether anything has been open yet. Without it a mount with nothing open
   * "restored" the page to its initial 0 and held it there for the length of
   * the attempt, which is not a restore — it is a lock on the top of the
   * page that anything else putting the list back where it was has to fight.
   */
  const hasOpenedRef = useRef(false);

  const remember = useCallback(() => {
    savedScrollRef.current = window.scrollY;
  }, []);

  useEffect(() => {
    if (openKey) {
      hasOpenedRef.current = true;
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      return;
    }
    if (!hasOpenedRef.current) return;
    return restoreScrollTo(savedScrollRef.current);
  }, [openKey]);

  return remember;
}
