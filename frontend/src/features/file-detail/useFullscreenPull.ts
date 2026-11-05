import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

import { swipeAxis, swipeVerdict } from './useDetailSwipe';

/** Matches the track's snap-back in app.css. */
const SETTLE_MS = 220;
/** Before fullscreen the picture moves half as far as the finger: a pull with some give. */
const PULL_GIVE = 0.5;
/** How much smaller a picture dragged a whole screen away from fullscreen gets. */
const SHRINK = 0.25;

type Pull = { fullscreen: boolean; dy: number; settling: boolean };

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
 * the finger, and the fullscreen view transition carries it on from where the
 * finger let go. A sideways drag stays with useDetailSwipe and two fingers with
 * useMediaZoom: all of them read the same swipeAxis, so one gesture never does
 * two things.
 *
 * Returns the style for the picture's box while it is being dragged.
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
}): CSSProperties | undefined {
  const [pull, setPull] = useState<Pull | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Runs after the render that changed fullscreen, which the transition has already pictured
  // from under the finger. Without it, leaving fullscreen with a button would bring back the
  // offset of the drag that entered it.
  useEffect(() => setPull(null), [itemKey, fullscreen]);

  useEffect(() => {
    if (!pull?.settling) return;
    const timer = window.setTimeout(() => setPull(null), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [pull]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!enabled || zoomed || !wrap) return;
    let gesture: {
      startX: number;
      startY: number;
      startedAt: number;
      dy: number;
      axis: ReturnType<typeof swipeAxis>;
    } | null = null;

    const settle = () => setPull({ fullscreen, dy: 0, settling: true });

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
      setPull({
        fullscreen,
        dy: fullscreen ? gesture.dy : gesture.dy * PULL_GIVE,
        settling: false
      });
    };

    const onEnd = () => {
      const ended = gesture;
      gesture = null;
      if (ended?.axis !== 'y') return;
      if (
        pullCommits(
          fullscreen,
          ended.dy,
          performance.now() - ended.startedAt,
          window.innerHeight
        )
      ) {
        // The dragged picture stays where it is until fullscreen changes,
        // so the transition starts from under the finger.
        onChangeRef.current(!fullscreen);
        return;
      }
      settle();
    };

    wrap.addEventListener('touchstart', onStart, { passive: true });
    wrap.addEventListener('touchmove', onMove, { passive: false });
    wrap.addEventListener('touchend', onEnd);
    wrap.addEventListener('touchcancel', onEnd);
    return () => {
      wrap.removeEventListener('touchstart', onStart);
      wrap.removeEventListener('touchmove', onMove);
      wrap.removeEventListener('touchend', onEnd);
      wrap.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled, fullscreen, zoomed, itemKey, wrapRef]);

  // A drag that started on the other side of a fullscreen change is over.
  if (!pull || pull.fullscreen !== fullscreen) return undefined;
  const shrink = fullscreen
    ? 1 - (Math.min(Math.abs(pull.dy), window.innerHeight) / window.innerHeight) * SHRINK
    : 1;
  return {
    transform: `translateY(${pull.dy}px) scale(${shrink})`,
    transition: pull.settling ? `transform ${SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` : undefined
  };
}
