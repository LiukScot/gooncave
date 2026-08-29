import { useCallback, useEffect, useRef, useState } from 'react';
import type { TouchEventHandler } from 'react';

type SwipeAxis = 'idle' | 'x' | 'y';

/** How long the snap-back / hand-off animation runs, matching app.css. */
const SLIDE_MS = 220;

/** Reads `--file-detail-video-controls` (see app.css), which is in px. */
const nativeVideoControlsHeight = (video: Element): number =>
  parseFloat(
    getComputedStyle(video).getPropertyValue('--file-detail-video-controls')
  ) || 0;

/**
 * Whether a finished gesture moves to a neighbour, and which way.
 *
 * A swipe counts either by distance — 22% of the frame, capped at 140px so a
 * tablet does not ask for an arm's length — or by being flung: a short but
 * fast flick is how the gesture reads on a phone held one-handed.
 *
 * @param dx horizontal travel in px, positive when moving right (= previous)
 * @param elapsedMs duration of the gesture, never zero
 * @param width the frame's width in px
 * @returns -1 for the previous item, 1 for the next, 0 to snap back
 */
export const swipeVerdict = (
  dx: number,
  elapsedMs: number,
  width: number
): -1 | 0 | 1 => {
  const velocity = dx / Math.max(1, elapsedMs);
  const threshold = Math.min(140, width * 0.22);
  if (dx > threshold || (dx > 28 && velocity > 0.45)) return -1;
  if (dx < -threshold || (dx < -28 && velocity < -0.45)) return 1;
  return 0;
};

export type DetailSwipe = {
  /** Goes on the element the gesture is measured against (the frame). */
  frameRef: React.RefObject<HTMLDivElement | null>;
  /** Pixels the track has followed the finger. */
  offset: number;
  /** The track is animating, so it must not follow a new touch yet. */
  transitioning: boolean;
  /** A horizontal swipe is in progress: the page must not scroll under it. */
  locked: boolean;
  onTouchStart: TouchEventHandler<HTMLDivElement>;
  onTouchEnd: () => void;
};

/**
 * The horizontal swipe that moves a detail view to its neighbour.
 *
 * The gesture only ever reports; the caller decides what "the neighbour" is
 * and switches to it from `onCommit`, which fires once the slide has finished
 * so the picture is already off-screen when the content changes.
 *
 * `canPrev` / `canNext` are the ends of the list: a swipe towards a missing
 * neighbour is rubber-banded instead of committed.
 */
export function useDetailSwipe({
  open,
  itemKey,
  canPrev,
  canNext,
  onCommit
}: {
  open: boolean;
  /** Identifies the current item; a change resets any gesture in flight. */
  itemKey: string | null;
  canPrev: boolean;
  canNext: boolean;
  onCommit: (delta: -1 | 1) => void;
}): DetailSwipe {
  const [offset, setOffset] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const [locked, setLocked] = useState(false);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const gestureRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    lastX: number;
    startedAt: number;
    axis: SwipeAxis;
  }>({
    active: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    startedAt: 0,
    axis: 'idle'
  });

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimer();
    gestureRef.current = {
      active: false,
      startX: 0,
      startY: 0,
      lastX: 0,
      startedAt: 0,
      axis: 'idle'
    };
    setLocked(false);
    setTransitioning(false);
    setOffset(0);
  }, [clearTimer]);

  useEffect(() => {
    reset();
  }, [reset, itemKey]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const settle = useCallback(() => {
    setTransitioning(true);
    setOffset(0);
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setTransitioning(false);
    }, SLIDE_MS);
  }, [clearTimer]);

  const commit = useCallback(
    (delta: -1 | 1) => {
      const width = frameRef.current?.clientWidth || window.innerWidth || 1;
      setTransitioning(true);
      setOffset(delta < 0 ? width : -width);
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setTransitioning(false);
        onCommit(delta);
        setOffset(0);
      }, SLIDE_MS);
    },
    [clearTimer, onCommit]
  );

  const onTouchStart = useCallback<TouchEventHandler<HTMLDivElement>>(
    (event) => {
      if (transitioning || event.touches.length !== 1) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, a, input, textarea, select, label')) return;
      const touch = event.touches[0];
      // A video used to be excluded outright, to keep a drag on the native
      // seek bar from turning into a swipe. In fullscreen the video covers
      // the screen, so that left no surface to swipe from at all. Guard only
      // the strip the native controls actually occupy.
      const video = target?.closest('video');
      if (
        video &&
        touch.clientY >
          video.getBoundingClientRect().bottom -
            nativeVideoControlsHeight(video)
      ) {
        return;
      }
      clearTimer();
      gestureRef.current = {
        active: true,
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        startedAt: performance.now(),
        axis: 'idle'
      };
      setTransitioning(false);
    },
    [clearTimer, transitioning]
  );

  const onTouchMove = useCallback(
    (event: globalThis.TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture.active || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      gesture.lastX = touch.clientX;
      if (gesture.axis === 'idle') {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        gesture.axis = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'x' : 'y';
      }
      if (gesture.axis !== 'x') return;
      setLocked(true);
      event.preventDefault();
      let nextOffset = dx;
      if ((dx > 0 && !canPrev) || (dx < 0 && !canNext)) {
        nextOffset *= 0.28;
      }
      setTransitioning(false);
      setOffset(nextOffset);
    },
    [canNext, canPrev]
  );

  // React registers `touchmove` on its root as a passive listener, so the
  // preventDefault() above is ignored there and the page keeps scrolling
  // vertically mid-swipe. Bind it natively instead. The handler is read
  // through a ref so a new callback identity does not detach the listener in
  // the middle of a gesture.
  const onTouchMoveRef = useRef(onTouchMove);
  onTouchMoveRef.current = onTouchMove;

  useEffect(() => {
    const frame = frameRef.current;
    if (!open || !frame) return;
    const handler = (event: globalThis.TouchEvent) =>
      onTouchMoveRef.current(event);
    frame.addEventListener('touchmove', handler, { passive: false });
    return () => frame.removeEventListener('touchmove', handler);
  }, [open]);

  const onTouchEnd = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture.active) return;
    gesture.active = false;
    setLocked(false);
    if (gesture.axis !== 'x') {
      gesture.axis = 'idle';
      return;
    }
    const width = frameRef.current?.clientWidth || window.innerWidth || 1;
    const verdict = swipeVerdict(
      gesture.lastX - gesture.startX,
      performance.now() - gesture.startedAt,
      width
    );
    if (verdict === -1 && canPrev) {
      commit(-1);
      return;
    }
    if (verdict === 1 && canNext) {
      commit(1);
      return;
    }
    settle();
  }, [canNext, canPrev, commit, settle]);

  return {
    frameRef,
    offset,
    transitioning,
    locked,
    onTouchStart,
    onTouchEnd
  };
}

/**
 * Freezes the page behind a detail view: the document must not scroll under
 * a fullscreen picture, nor sideways-scroll while a swipe is in flight.
 */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const bodyStyle = document.body.style;
    const htmlStyle = document.documentElement.style;
    const prevBody = {
      overflow: bodyStyle.overflow,
      overscrollBehavior: bodyStyle.overscrollBehavior
    };
    const prevHtml = {
      overflow: htmlStyle.overflow,
      overscrollBehavior: htmlStyle.overscrollBehavior
    };
    bodyStyle.overflow = 'hidden';
    bodyStyle.overscrollBehavior = 'none';
    htmlStyle.overflow = 'hidden';
    htmlStyle.overscrollBehavior = 'none';
    return () => {
      bodyStyle.overflow = prevBody.overflow;
      bodyStyle.overscrollBehavior = prevBody.overscrollBehavior;
      htmlStyle.overflow = prevHtml.overflow;
      htmlStyle.overscrollBehavior = prevHtml.overscrollBehavior;
    };
  }, [active]);
}
