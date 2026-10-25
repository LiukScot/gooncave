import { useRouter, type AnyRouter } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { supportsViewTransitions } from '@/lib/viewTransitions';

/** A touch that starts this close to the left edge is a swipe back. */
const EDGE_PX = 24;
/** Horizontal travel before the gesture is claimed, so a tap stays a tap. */
const CLAIM_PX = 8;
/**
 * How far travel across has to lead travel along before an edge touch is a
 * swipe back. A thumb scrolling a page near its edge drifts sideways too, and
 * claiming that freezes the scroll. Vertical wins ties, as in the picture swipe.
 */
const CLAIM_DOMINANCE = 2;
/** Share of the width that commits the swipe on release. */
const COMMIT_RATIO = 0.35;
/** A quick flick commits after this much travel, in px per ms. */
const FLICK_SPEED = 0.5;
const FLICK_MIN_PX = 30;
/** The pseudo-element animations run over this scale; the finger sets the time. */
const SCALE_MS = 1000;
/** How long the page takes to finish or return once the finger lifts. */
const SETTLE_MS = 220;
/** The page behind starts this far to the left and slides into place. */
const BEHIND_SHIFT = '-25%';
/** Share of the gap to the finger that the pictures close each frame. */
const CATCH_UP = 0.35;

/** Whether releasing at `travel` px after `elapsed` ms leaves the page. */
export const commitsSwipe = (
  travel: number,
  width: number,
  elapsed: number
): boolean =>
  travel >= width * COMMIT_RATIO ||
  (travel >= FLICK_MIN_PX && travel / Math.max(elapsed, 1) >= FLICK_SPEED);

let running = false;

/** The router must not start a transition of its own under a swipe. */
export const isSwipeBackRunning = (): boolean => running;

/**
 * Frames are not drawn while a transition waits for its update, so this cannot
 * wait for one. React commits the navigation in a microtask after the router
 * resolves, so the next task already sees the new page.
 */
const settleRender = () =>
  new Promise<void>((resolve) => window.setTimeout(resolve, 0));

/** Resolves once the router has applied the navigation and React has committed it. */
const afterNavigation = (router: AnyRouter, run: () => void): Promise<void> =>
  new Promise((resolve) => {
    let unsubscribe: () => void = () => undefined;
    let timer = 0;
    const done = () => {
      unsubscribe();
      window.clearTimeout(timer);
      void settleRender().then(resolve);
    };
    // A navigation that never resolves must not freeze the page on a snapshot.
    timer = window.setTimeout(done, 600);
    unsubscribe = router.subscribe('onResolved', done);
    run();
  });

type Gesture = {
  startX: number;
  startY: number;
  startedAt: number;
  width: number;
  claimed: boolean;
  travel: number;
  /** Travel the pictures show: it runs after `travel` until it catches up. */
  shown: number;
  frame: number;
  animations: Animation[];
  ready: Promise<void>;
};

const slide = (pseudo: string, from: string, to: string): Animation => {
  const animation = document.documentElement.animate(
    { transform: [`translateX(${from})`, `translateX(${to})`] },
    {
      duration: SCALE_MS,
      easing: 'linear',
      fill: 'both',
      pseudoElement: pseudo
    }
  );
  animation.pause();
  return animation;
};

/**
 * The swipe from the left edge that goes back one history entry, with the
 * page it returns to showing underneath while the finger moves. The page
 * moves with the finger through a view transition whose animations are
 * driven by hand; the iOS gesture does not do it, because it has no picture
 * of a page that only changed the URL.
 *
 * `canSwipeBack` is asked when a touch starts, so it can read refs.
 * Letting go short of the threshold goes forward again to the page that was
 * left, which comes back as it was opened; `onCancelled` runs then, so the
 * owner can record that the entry it returns to is one it may go back from.
 */
export function useEdgeSwipeBack(
  canSwipeBack: () => boolean,
  onCancelled?: () => void
): void {
  const router = useRouter();
  const canSwipeBackRef = useRef(canSwipeBack);
  canSwipeBackRef.current = canSwipeBack;
  const onCancelledRef = useRef(onCancelled);
  onCancelledRef.current = onCancelled;

  useEffect(() => {
    // Capture on the document so a picture's own swipe never sees an edge touch.
    const options = { capture: true, passive: false } as const;
    let gesture: Gesture | null = null;
    // A touch keeps reporting to the element it started on, and the page
    // under the thumb is gone as soon as the swipe goes back: events of a
    // detached element never reach the document, so WebKit would never see the
    // release and the transition would stay frozen on its picture.
    let touched: EventTarget | null = null;

    const seek = (current: Gesture) => {
      const progress = Math.min(Math.max(current.shown / current.width, 0), 1);
      for (const animation of current.animations) {
        animation.currentTime = progress * SCALE_MS;
      }
    };

    // The transition is ready some frames after the finger started, and the
    // pictures would jump to wherever it is by then. They run after it instead.
    const follow = (current: Gesture) => {
      const gap = current.travel - current.shown;
      current.shown = Math.abs(gap) < 0.5 ? current.travel : current.shown + gap * CATCH_UP;
      seek(current);
      current.frame = requestAnimationFrame(() => follow(current));
    };

    const claim = (current: Gesture) => {
      current.claimed = true;
      running = true;
      if (!supportsViewTransitions) {
        // Nothing follows the finger, and back happens on release.
        return;
      }
      const transition = (
        document as unknown as {
          startViewTransition: (options: {
            update: () => Promise<void>;
            types: string[];
          }) => ViewTransition;
        }
      ).startViewTransition({
        update: () => afterNavigation(router, () => router.history.back()),
        types: ['swipe-back']
      });
      current.ready = transition.ready.then(
        () => {
          current.animations = [
            slide('::view-transition-old(root)', '0px', '100%'),
            slide('::view-transition-new(root)', BEHIND_SHIFT, '0px')
          ];
          follow(current);
        },
        // A skipped transition still ran its update, so back has happened.
        () => undefined
      );
    };

    const finish = async (current: Gesture, commit: boolean) => {
      if (!supportsViewTransitions) {
        running = false;
        if (commit) router.history.back();
        return;
      }
      try {
        await current.ready;
        cancelAnimationFrame(current.frame);
        current.shown = current.travel;
        seek(current);
        if (!commit) {
          router.history.forward();
          onCancelledRef.current?.();
        }
        const progress = Math.min(current.travel / current.width, 1);
        const remaining = commit ? 1 - progress : progress;
        for (const animation of current.animations) {
          animation.playbackRate =
            ((commit ? 1 : -1) * Math.max(remaining * SCALE_MS, 1)) / SETTLE_MS;
          animation.play();
        }
        await Promise.all(current.animations.map((a) => a.finished)).catch(
          () => undefined
        );
      } finally {
        running = false;
      }
    };

    const listen = (target: EventTarget | null, on: boolean) => {
      const toggle = on ? 'addEventListener' : 'removeEventListener';
      target?.[toggle]('touchmove', onMove as EventListener, options);
      target?.[toggle]('touchend', onEnd as EventListener, options);
      target?.[toggle]('touchcancel', onCancel, options);
    };

    const onStart = (event: TouchEvent) => {
      if (gesture || running || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (touch.clientX > EDGE_PX || !canSwipeBackRef.current()) return;
      gesture = {
        startX: touch.clientX,
        startY: touch.clientY,
        startedAt: event.timeStamp,
        width: window.innerWidth,
        claimed: false,
        travel: 0,
        shown: 0,
        frame: 0,
        animations: [],
        ready: Promise.resolve()
      };
      touched = event.target;
      listen(touched, true);
    };

    const onMove = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      if (!gesture.claimed) {
        if (Math.abs(dy) > CLAIM_PX && dx < Math.abs(dy) * CLAIM_DOMINANCE) {
          gesture = null;
          return;
        }
        if (dx < CLAIM_PX || dx < Math.abs(dy) * CLAIM_DOMINANCE) return;
        claim(gesture);
      }
      // The page must not scroll, and the picture swipe must not see this.
      event.preventDefault();
      event.stopPropagation();
      gesture.travel = Math.max(dx, 0);
    };

    const onEnd = (event: TouchEvent) => {
      const current = gesture;
      gesture = null;
      listen(touched, false);
      if (!current?.claimed) return;
      event.stopPropagation();
      void finish(
        current,
        commitsSwipe(current.travel, current.width, event.timeStamp - current.startedAt)
      );
    };

    const onCancel = () => {
      const current = gesture;
      gesture = null;
      listen(touched, false);
      if (current?.claimed) void finish(current, false);
    };

    document.addEventListener('touchstart', onStart, options);
    document.addEventListener('touchmove', onMove, options);
    document.addEventListener('touchend', onEnd, options);
    document.addEventListener('touchcancel', onCancel, options);
    return () => {
      listen(touched, false);
      if (gesture?.claimed) {
        running = false;
        cancelAnimationFrame(gesture.frame);
      }
      document.removeEventListener('touchstart', onStart, options);
      document.removeEventListener('touchmove', onMove, options);
      document.removeEventListener('touchend', onEnd, options);
      document.removeEventListener('touchcancel', onCancel, options);
    };
  }, [router]);
}
