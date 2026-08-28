import { useCallback, useEffect, useRef } from 'react';

// The list page keeps growing as tiles lay out, and a scroll clamped short
// does not catch up on its own — so retry until the target is reached.
// Budget in milliseconds, not frames: a frame count is a wall-clock budget
// that shrinks exactly when layout is slowest (a loaded machine drops
// frames), which made this give up early and land short.
const RESTORE_TIMEOUT_MS = 3_000;
// Reaching the offset once is not enough to keep it. The router scrolls to
// 0,0 when it commits the location a close is navigating to, and that lands
// a few ms either side of the restore — before it on a fast machine, after
// it on a slow one, where it silently undid the whole thing. Hold the
// position briefly instead of racing for who writes last.
const HOLD_MS = 500;

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

  const remember = useCallback(() => {
    savedScrollRef.current = window.scrollY;
  }, []);

  useEffect(() => {
    if (openKey) {
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      return;
    }
    // Defer to the next frame: the list remounts when the detail closes, so
    // scrolling synchronously would land on a not-yet-laid-out page and
    // clamp to the top.
    const startedAt = performance.now();
    let reachedAt: number | null = null;
    let rafId: number;
    let stopped = false;
    // A restore that keeps yanking the page back would fight a user who
    // started scrolling on their own; their input wins.
    const abort = () => {
      stopped = true;
    };
    window.addEventListener('wheel', abort, { passive: true, once: true });
    window.addEventListener('touchstart', abort, { passive: true, once: true });
    const stopListening = () => {
      window.removeEventListener('wheel', abort);
      window.removeEventListener('touchstart', abort);
    };

    const restore = () => {
      const target = savedScrollRef.current;
      if (Math.abs(window.scrollY - target) > 1) {
        window.scrollTo({ top: target, behavior: 'instant' as ScrollBehavior });
      }
      const now = performance.now();
      if (Math.abs(window.scrollY - target) <= 1) {
        reachedAt ??= now;
      }
      const held = reachedAt !== null && now - reachedAt >= HOLD_MS;
      if (!held && !stopped && now - startedAt < RESTORE_TIMEOUT_MS) {
        rafId = requestAnimationFrame(restore);
        return;
      }
      stopListening();
    };
    rafId = requestAnimationFrame(restore);
    return () => {
      cancelAnimationFrame(rafId);
      stopListening();
    };
  }, [openKey]);

  return remember;
}
