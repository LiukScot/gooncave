import { useCallback, useEffect, useRef } from 'react';

import {
  anchoredScrollTarget,
  restoreScrollTo,
  type ScrollRestorePlace,
  withScrollAnchor
} from './restoreScrollTo';

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
export function useDetailScrollRestore(
  openKey: string | null
): (anchorId?: string, preserveViewport?: boolean) => void {
  const savedPlaceRef = useRef<ScrollRestorePlace>({
    scrollY: 0,
    anchorId: null,
    viewportTop: null
  });
  /**
   * Whether anything has been open yet. Without it a mount with nothing open
   * "restored" the page to its initial 0 and held it there for the length of
   * the attempt, which is not a restore — it is a lock on the top of the
   * page that anything else putting the list back where it was has to fight.
   */
  const hasOpenedRef = useRef(false);

  const remember = useCallback((anchorId?: string, preserveViewport = false) => {
    if (anchorId && preserveViewport) {
      savedPlaceRef.current = withScrollAnchor(savedPlaceRef.current, anchorId);
      return;
    }
    const anchor = anchorId
      ? document.querySelector<HTMLElement>(
          `[data-detail-anchor=${JSON.stringify(anchorId)}]`
        )
      : null;
    savedPlaceRef.current = {
      scrollY: window.scrollY,
      anchorId: anchorId ?? null,
      viewportTop: anchor?.getBoundingClientRect().top ?? null
    };
  }, []);

  useEffect(() => {
    if (openKey) {
      hasOpenedRef.current = true;
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      return;
    }
    if (!hasOpenedRef.current) return;
    const saved = savedPlaceRef.current;
    return restoreScrollTo(() => {
      const anchor = saved.anchorId
        ? document.querySelector<HTMLElement>(
            `[data-detail-anchor=${JSON.stringify(saved.anchorId)}]`
          )
        : null;
      return anchoredScrollTarget({
        savedScrollY: saved.scrollY,
        savedViewportTop: saved.viewportTop,
        currentScrollY: window.scrollY,
        currentViewportTop: anchor?.getBoundingClientRect().top ?? null
      });
    });
  }, [openKey]);

  return remember;
}
