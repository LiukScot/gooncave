import { useRef, type MouseEvent, type TouchEvent } from 'react';

import type { DoubleTapAction } from '@/api';

/** The longest gap between two taps that still makes a double tap. */
export const DOUBLE_TAP_MS = 300;
/** How far a finger may move during a tap, and how far apart two taps of a pair may land. */
const TAP_SLOP = 24;

type Tap = { at: number; x: number; y: number };

const isDoubleTap = (previous: Tap | null, next: Tap): boolean =>
  previous !== null &&
  next.at - previous.at <= DOUBLE_TAP_MS &&
  Math.hypot(next.x - previous.x, next.y - previous.y) <= TAP_SLOP;

/**
 * Two quick taps in the same place, read from the touches. iOS does not
 * reliably turn them into a `dblclick`, so nothing that waits for one hears them.
 */
export function useTouchDoubleTap(onDoubleTap: (event: TouchEvent, x: number, y: number) => void) {
  const start = useRef<Tap | null>(null);
  const lastTap = useRef<Tap | null>(null);
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
      onDoubleTap(event, tap.x, tap.y);
    }
  };
}

/** Where a tap at `x` falls on a video: its left third, middle or right third. */
export const videoThird = (video: HTMLVideoElement, x: number): 'back' | 'middle' | 'forward' => {
  const { left, width } = video.getBoundingClientRect();
  const at = (x - left) / width;
  return at <= 1 / 3 ? 'back' : at >= 2 / 3 ? 'forward' : 'middle';
};

/**
 * Double tap or double click on the detail picture: resets a zoom, otherwise enters fullscreen,
 * and in fullscreen does what `action` says: `zoom` zooms in on the tapped point, `exit` leaves
 * fullscreen. The touches are
 * read here because iOS does not reliably turn two quick taps into a `dblclick`; a `dblclick`
 * that echoes a double tap already handled is ignored. The sides of a video are left to
 * VideoPlayer, which skips back and forward there.
 */
export function useDoubleTapFullscreen({
  action,
  fullscreen,
  zoom,
  toggle
}: {
  action: DoubleTapAction;
  fullscreen: boolean;
  zoom: { zoomed: boolean; reset: () => void; zoomInOn: (client: { x: number; y: number }) => void };
  toggle: () => void;
}) {
  const handledAt = useRef(-Infinity);
  const act = (target: EventTarget, point: { x: number; y: number }) => {
    if (zoom.zoomed) {
      zoom.reset();
      return;
    }
    // The picture, or the black bands around it in fullscreen; not a button or a control.
    const onPicture =
      target instanceof HTMLImageElement ||
      target instanceof HTMLVideoElement ||
      (target instanceof Element && target.classList.contains('file-detail-media-wrap'));
    if (!onPicture) return;
    if (fullscreen && action === 'zoom') zoom.zoomInOn(point);
    else toggle();
  };

  const touch = useTouchDoubleTap((event, x, y) => {
    handledAt.current = performance.now();
    const target = event.target;
    // The sides of a video skip back and forward (VideoPlayer).
    if (target instanceof HTMLVideoElement && !zoom.zoomed && videoThird(target, x) !== 'middle') return;
    act(target, { x, y });
  });

  return {
    ...touch,
    onDoubleClick: (event: MouseEvent) => {
      if (performance.now() - handledAt.current < 2 * DOUBLE_TAP_MS) return;
      act(event.target, { x: event.clientX, y: event.clientY });
    }
  };
}
