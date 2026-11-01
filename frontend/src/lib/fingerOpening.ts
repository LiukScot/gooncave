import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { CLAIM_PX, commitsSwipe } from '@/lib/edgeSwipeBack';

/** Something that moves with the opening; `at` gets 0 for closed, 1 for open. */
export type OpeningLayer = {
  element: HTMLElement | null;
  at: (progress: number) => Keyframe;
};

/** How long a whole opening takes once nothing holds it; a part takes its share. */
const SETTLE_MS = 280;
const MIN_SETTLE_MS = 120;

type Options = {
  open: boolean;
  setOpen: (open: boolean) => void;
  axis: 'x' | 'y';
  /** The direction along the axis that opens: 1 for right or down, -1 for left or up. */
  opensToward: 1 | -1;
  /** How far travel along the axis has to lead travel across before it counts. */
  dominance: number;
  /** Asked when a touch starts. */
  canDrag: (target: Element, open: boolean) => boolean;
  layers: (size: number) => OpeningLayer[];
};

const show = (layers: OpeningLayer[], progress: number) => {
  for (const { element, at } of layers) {
    if (element) Object.assign(element.style, at(progress));
  }
};

/**
 * Something that opens and closes with the finger on it from start to end, and
 * glides the rest of the way when let go. The finger can catch it mid-glide.
 * While `open` is false and the glide is over, the returned flag unmounts it.
 */
export function useFingerOpening(options: Options): {
  mounted: boolean;
  /** Give it the element that opens, as its ref. Its transform says how far open it is; closed, CSS moves it by its full size. */
  attach: (element: HTMLElement | null) => void;
} {
  const { open } = options;
  const [mounted, setMounted] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const dragging = useRef(false);
  const anchor = useRef<HTMLElement | null>(null);
  const running = useRef<Animation[]>([]);

  const sizeOf = (anchor: HTMLElement | null) =>
    latest.current.axis === 'x' ? (anchor?.offsetWidth ?? 0) : (anchor?.offsetHeight ?? 0);

  const progressOf = (anchor: HTMLElement | null, size: number) => {
    if (!anchor || !size) return 0;
    const { m41, m42 } = new DOMMatrixReadOnly(getComputedStyle(anchor).transform);
    const offset = latest.current.axis === 'x' ? m41 : m42;
    return Math.min(Math.max(1 + (latest.current.opensToward * offset) / size, 0), 1);
  };

  const settle = (to: 0 | 1) => {
    const { layers } = latest.current;
    const element = anchor.current;
    const size = sizeOf(element);
    const from = progressOf(element, size);
    for (const animation of running.current) animation.cancel();
    running.current = [];
    const shown = layers(size);
    const finish = () => {
      if (to === 1) return;
      for (const { element: layer } of shown) {
        layer?.style.removeProperty('transform');
        layer?.style.removeProperty('opacity');
      }
      setMounted(false);
    };
    show(shown, to);
    // Nothing to see, such as the drawer on a screen that keeps the menu showing.
    if (!size) return finish();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease-out-quint');
    const duration = reduced ? 0 : Math.max(MIN_SETTLE_MS, SETTLE_MS * Math.abs(to - from));
    running.current = shown.flatMap(({ element: layer, at }) =>
      layer ? [layer.animate([at(from), at(to)], { duration, easing })] : []
    );
    const [first] = running.current;
    if (first) first.onfinish = finish;
    else finish();
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;

  useLayoutEffect(() => {
    if (open && !mounted) {
      setMounted(true);
      return;
    }
    // Opening waits for `attach`: the dialog mounts its content some commits later.
    if (!mounted || dragging.current || !anchor.current) return;
    settleRef.current(open ? 1 : 0);
  }, [open, mounted]);

  const attach = useCallback((element: HTMLElement | null) => {
    anchor.current = element;
    // Closed before its content arrived, it still has to glide out to unmount.
    if (element && !dragging.current) settleRef.current(latest.current.open ? 1 : 0);
  }, []);

  // The offsets are pixels of the old size.
  useEffect(() => {
    const onResize = () => {
      if (latest.current.open && anchor.current && !dragging.current) settleRef.current(1);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    type Gesture = {
      finger: number;
      startMain: number;
      startCross: number;
      fromOpen: boolean;
      claimed: boolean;
      originMain: number;
      startedAt: number;
      size: number;
      from: number;
      progress: number;
      layers: OpeningLayer[];
    };
    let gesture: Gesture | null = null;
    const options = { capture: true, passive: false } as const;
    const main = (touch: Touch) => (latest.current.axis === 'x' ? touch.clientX : touch.clientY);
    const cross = (touch: Touch) => (latest.current.axis === 'x' ? touch.clientY : touch.clientX);
    const fingerIn = (event: TouchEvent, finger: number) =>
      Array.from(event.touches).find((touch) => touch.identifier === finger);

    const claim = (current: Gesture, touch: Touch, startedAt: number) => {
      dragging.current = true;
      flushSync(() => {
        setMounted(true);
        latest.current.setOpen(true);
      });
      const element = anchor.current;
      current.size = sizeOf(element);
      current.from = progressOf(element, current.size);
      for (const animation of running.current) animation.cancel();
      running.current = [];
      current.layers = latest.current.layers(current.size);
      current.originMain = main(touch);
      current.startedAt = startedAt;
      current.progress = current.from;
      current.claimed = true;
    };

    const onStart = (event: TouchEvent) => {
      // A second finger does not take over what the first one is holding.
      if (gesture?.claimed) return;
      gesture = null;
      if (event.touches.length !== 1 || !(event.target instanceof Element)) return;
      if (event.target.closest('input[type="range"], [role="slider"]')) return;
      const { open: isOpen, canDrag } = latest.current;
      // Still gliding shut, it is showing and can be caught.
      if (!canDrag(event.target, isOpen || Boolean(anchor.current))) return;
      const touch = event.touches[0];
      gesture = {
        finger: touch.identifier,
        startMain: main(touch),
        startCross: cross(touch),
        fromOpen: isOpen,
        claimed: false,
        originMain: 0,
        startedAt: 0,
        size: 0,
        from: 0,
        progress: 0,
        layers: []
      };
    };

    const onMove = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = fingerIn(event, gesture.finger);
      if (!touch) return;
      const toward = latest.current.opensToward;
      if (!gesture.claimed) {
        const along =
          (main(touch) - gesture.startMain) * toward * (gesture.fromOpen ? -1 : 1);
        const across = Math.abs(cross(touch) - gesture.startCross);
        const { dominance } = latest.current;
        if (along < -CLAIM_PX || (across > CLAIM_PX && along < across * dominance)) {
          gesture = null;
          return;
        }
        if (along < CLAIM_PX || along < across * dominance) return;
        // The browser has taken the touch for a scroll and will not give it back.
        if (!event.cancelable) {
          gesture = null;
          return;
        }
        claim(gesture, touch, event.timeStamp);
      }
      // The page must not scroll, and what lies under the finger must not see this.
      event.preventDefault();
      event.stopPropagation();
      if (!gesture.size) return;
      const moved = ((main(touch) - gesture.originMain) * toward) / gesture.size;
      gesture.progress = Math.min(Math.max(gesture.from + moved, 0), 1);
      show(gesture.layers, gesture.progress);
    };

    const release = (current: Gesture, commit: boolean) => {
      dragging.current = false;
      if (current.fromOpen ? commit : !commit) latest.current.setOpen(false);
      else settleRef.current(1);
    };

    const onEnd = (event: TouchEvent) => {
      const current = gesture;
      if (current && fingerIn(event, current.finger)) return;
      gesture = null;
      if (!current?.claimed) return;
      event.preventDefault();
      event.stopPropagation();
      const travel =
        (current.progress - current.from) * current.size * (current.fromOpen ? -1 : 1);
      release(
        current,
        current.size > 0 && commitsSwipe(travel, current.size, event.timeStamp - current.startedAt)
      );
    };

    const onCancel = () => {
      const current = gesture;
      gesture = null;
      if (current?.claimed) release(current, false);
    };

    document.addEventListener('touchstart', onStart, options);
    document.addEventListener('touchmove', onMove, options);
    document.addEventListener('touchend', onEnd, options);
    document.addEventListener('touchcancel', onCancel, options);
    return () => {
      document.removeEventListener('touchstart', onStart, options);
      document.removeEventListener('touchmove', onMove, options);
      document.removeEventListener('touchend', onEnd, options);
      document.removeEventListener('touchcancel', onCancel, options);
    };
  }, []);

  return { mounted, attach };
}
