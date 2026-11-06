import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

import { swipeAxis, swipeVerdict } from './useDetailSwipe';

/** Matches the snap-back below. */
const SETTLE_MS = 220;
/** Before fullscreen the picture moves half as far as the finger: a pull with some give. */
const PULL_GIVE = 0.5;
/** How much smaller a picture dragged a whole screen away from fullscreen gets. */
const SHRINK = 0.25;

/** Whether a vertical drag of `dy` px, `elapsedMs` long, changes fullscreen. */
export const pullCommits = (
  fullscreen: boolean,
  dy: number,
  elapsedMs: number,
  height: number
): boolean => {
  const verdict = swipeVerdict(dy, elapsedMs, height);
  // swipeVerdict reads -1 as travel towards positive values: down the screen.
  return fullscreen ? verdict !== 0 : verdict === -1;
};

/**
 * The vertical drag on the detail picture: down from the top of the page
 * enters fullscreen, up or down in fullscreen leaves it. The picture follows
 * the finger, and useFullscreenFlip carries it on from where the finger let go.
 * A sideways drag stays with useDetailSwipe and two fingers with useMediaZoom: all of them read the same swipeAxis, so one gesture never does
 * two things.
 *
 * The drag writes the picture's transform straight to its style, once a frame:
 * rendering the whole detail page on every finger move made the drag stutter.
 */
export function useFullscreenPull({
  wrapRef,
  enabled,
  fullscreen,
  zoomed,
  itemKey,
  onChange
}: {
  wrapRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  fullscreen: boolean;
  zoomed: boolean;
  itemKey: string | null;
  onChange: (fullscreen: boolean) => void;
}): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // In the commit that changed fullscreen, before useFullscreenFlip measures where the picture
  // now is: the drag's offset belongs to the old layout.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.style.transform = '';
    wrap.style.transition = '';
  }, [itemKey, fullscreen, wrapRef]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!enabled || zoomed || !wrap) return;
    let gesture: {
      startX: number;
      startY: number;
      startedAt: number;
      dy: number;
      /** How far the picture is drawn: the finger's travel, with the pull's give. */
      shown: number;
      axis: ReturnType<typeof swipeAxis>;
    } | null = null;
    let frame = 0;
    let settleTimer = 0;

    const place = (dy: number) => {
      const shrink = fullscreen
        ? 1 - (Math.min(Math.abs(dy), window.innerHeight) / window.innerHeight) * SHRINK
        : 1;
      wrap.style.transition = '';
      wrap.style.transform = `translateY(${dy}px) scale(${shrink})`;
    };

    const settle = () => {
      window.cancelAnimationFrame(frame);
      wrap.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      wrap.style.transform = '';
      settleTimer = window.setTimeout(() => {
        wrap.style.transition = '';
      }, SETTLE_MS);
    };

    const onStart = (event: TouchEvent) => {
      gesture = null;
      if (event.touches.length !== 1) return;
      // Buttons and the video's own bar keep their taps and drags.
      if ((event.target as Element).closest('button, input, a, .video-controls')) return;
      // Only from the top: further down, dragging the picture scrolls the page.
      if (!fullscreen && window.scrollY > 0) return;
      const touch = event.touches[0];
      gesture = {
        startX: touch.clientX,
        startY: touch.clientY,
        startedAt: performance.now(),
        dy: 0,
        shown: 0,
        axis: 'idle'
      };
    };

    const onMove = (event: TouchEvent) => {
      if (!gesture) return;
      // A second finger is a pinch.
      if (event.touches.length !== 1) {
        if (gesture.axis === 'y') settle();
        gesture = null;
        return;
      }
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      if (gesture.axis === 'idle') {
        gesture.axis = swipeAxis(dx, dy);
        if (gesture.axis === 'idle') return;
        // Sideways is the next file; upwards before fullscreen scrolls the page.
        if (gesture.axis === 'x' || (!fullscreen && dy < 0)) {
          gesture = null;
          return;
        }
      }
      // Stops the page scrolling or bouncing under the picture.
      event.preventDefault();
      gesture.dy = fullscreen ? dy : Math.max(0, dy);
      const shown = fullscreen ? gesture.dy : gesture.dy * PULL_GIVE;
      gesture.shown = shown;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => place(shown));
    };

    const onEnd = () => {
      const ended = gesture;
      gesture = null;
      if (ended?.axis !== 'y') return;
      window.cancelAnimationFrame(frame);
      if (
        pullCommits(
          fullscreen,
          ended.dy,
          performance.now() - ended.startedAt,
          window.innerHeight
        )
      ) {
        // The dragged picture stays where it is until fullscreen changes,
        // so the animation starts from under the finger.
        place(ended.shown);
        onChangeRef.current(!fullscreen);
        return;
      }
      settle();
    };

    // The system took the touch away: nothing was decided, so the picture goes back.
    const onCancel = () => {
      const ended = gesture;
      gesture = null;
      if (ended?.axis === 'y') settle();
    };

    wrap.addEventListener('touchstart', onStart, { passive: true });
    wrap.addEventListener('touchmove', onMove, { passive: false });
    wrap.addEventListener('touchend', onEnd);
    wrap.addEventListener('touchcancel', onCancel);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      wrap.removeEventListener('touchstart', onStart);
      wrap.removeEventListener('touchmove', onMove);
      wrap.removeEventListener('touchend', onEnd);
      wrap.removeEventListener('touchcancel', onCancel);
    };
  }, [enabled, fullscreen, zoomed, itemKey, wrapRef]);
}
