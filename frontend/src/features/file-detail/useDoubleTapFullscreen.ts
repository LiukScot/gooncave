import { useRef, type MouseEvent, type TouchEvent } from 'react';

/** The longest gap between two taps that still makes a double tap. */
const DOUBLE_TAP_MS = 300;
/** How far a finger may move during a tap, and how far apart two taps of a pair may land. */
const TAP_SLOP = 24;

type Tap = { at: number; x: number; y: number };

const isDoubleTap = (previous: Tap | null, next: Tap): boolean =>
  previous !== null &&
  next.at - previous.at <= DOUBLE_TAP_MS &&
  Math.hypot(next.x - previous.x, next.y - previous.y) <= TAP_SLOP;

/**
 * Double tap or double click on the detail picture: resets a zoom, otherwise
 * enters or leaves fullscreen when the setting allows it. The touches are read
 * here because iOS does not reliably turn two quick taps into a `dblclick`; a
 * `dblclick` that echoes a double tap already handled is ignored. The sides of
 * a video are left to VideoPlayer, which skips back and forward there.
 */
export function useDoubleTapFullscreen({
  enabled,
  zoom,
  toggle
}: {
  enabled: boolean;
  zoom: { zoomed: boolean; reset: () => void };
  toggle: () => void;
}) {
  const start = useRef<Tap | null>(null);
  const lastTap = useRef<Tap | null>(null);
  const handledAt = useRef(-Infinity);

  const act = (target: EventTarget) => {
    if (zoom.zoomed) {
      zoom.reset();
      return;
    }
    // On the picture itself, not the letterboxing: the first click of a double
    // click there has already left fullscreen, and this would walk straight back in.
    if (enabled && (target instanceof HTMLImageElement || target instanceof HTMLVideoElement)) {
      toggle();
    }
  };

  return {
    onTouchStart: (event: TouchEvent) => {
      const touch = event.touches[0];
      start.current =
        event.touches.length === 1 ? { at: performance.now(), x: touch.clientX, y: touch.clientY } : null;
    },
    onTouchEnd: (event: TouchEvent) => {
      const began = start.current;
      start.current = null;
      const touch = event.changedTouches[0];
      if (!began || event.touches.length > 0 || !touch) return;
      const tap = { at: performance.now(), x: touch.clientX, y: touch.clientY };
      // A drag or a long press is not a tap.
      if (Math.hypot(tap.x - began.x, tap.y - began.y) > TAP_SLOP || tap.at - began.at > DOUBLE_TAP_MS) {
        lastTap.current = null;
        return;
      }
      if (!isDoubleTap(lastTap.current, tap)) {
        lastTap.current = tap;
        return;
      }
      lastTap.current = null;
      handledAt.current = tap.at;
      const target = event.target;
      if (target instanceof HTMLVideoElement && !zoom.zoomed) {
        const { left, width } = target.getBoundingClientRect();
        const at = (tap.x - left) / width;
        if (at <= 1 / 3 || at >= 2 / 3) return;
      }
      act(target);
    },
    onDoubleClick: (event: MouseEvent) => {
      if (performance.now() - handledAt.current < 2 * DOUBLE_TAP_MS) return;
      act(event.target);
    }
  };
}
