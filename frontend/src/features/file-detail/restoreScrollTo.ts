// The list page keeps growing as tiles lay out, and a scroll clamped short
// does not catch up on its own — so retry until the target is reached.
// Budget in milliseconds, not frames: a frame count is a wall-clock budget
// that shrinks exactly when layout is slowest (a loaded machine drops
// frames), which made this give up early and land short.
const RESTORE_TIMEOUT_MS = 3_000;
// Reaching the offset once is not enough to keep it. The router scrolls to
// 0,0 when it commits a location, and that lands a few ms either side of the
// restore — before it on a fast machine, after it on a slow one, where it
// silently undid the whole thing. Hold the position briefly instead of
// racing for who writes last.
const HOLD_MS = 500;

/**
 * Puts the window back to `target` and keeps it there while the page lays
 * out, giving up if the reader scrolls themselves. Returns the cleanup that
 * stops the attempt.
 *
 * Wanted wherever a list is mounted under a position it should already have:
 * the detail view closing, and explore being returned to from another page.
 */
export const restoreScrollTo = (target: number): (() => void) => {
  const startedAt = performance.now();
  let reachedAt: number | null = null;
  let rafId = 0;
  let stopped = false;
  // A restore that keeps yanking the page back would fight a reader who
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

  const step = () => {
    if (Math.abs(window.scrollY - target) > 1) {
      window.scrollTo({ top: target, behavior: 'instant' as ScrollBehavior });
    }
    const now = performance.now();
    if (Math.abs(window.scrollY - target) <= 1) {
      reachedAt ??= now;
    }
    const held = reachedAt !== null && now - reachedAt >= HOLD_MS;
    if (!held && !stopped && now - startedAt < RESTORE_TIMEOUT_MS) {
      rafId = requestAnimationFrame(step);
      return;
    }
    stopListening();
  };
  // Deferred to the next frame: the list is mounted in this commit, so
  // scrolling synchronously would land on a not-yet-laid-out page and clamp
  // to the top.
  rafId = requestAnimationFrame(step);
  return () => {
    cancelAnimationFrame(rafId);
    stopListening();
  };
};
