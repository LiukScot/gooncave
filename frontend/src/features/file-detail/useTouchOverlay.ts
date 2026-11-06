import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

import { swipeAxis } from './useDetailSwipe';

/** How long media controls stay visible after the latest pointer activity. */
export const OVERLAY_SHOW_MS = 4000;

// How long a mouse click waits to see that no second click, a double click, follows.
// Shorter than the system's double-click interval would let slow double clicks
// through as two single clicks; longer makes the click feel late.
const DOUBLE_CLICK_MS = 250;

const OVERLAY_CONTROL =
  '.file-detail-overlay-btn, .video-controls';

/**
 * Whether the controls on the picture show. A tap or a click on the picture
 * shows or hides them, mouse movement and keyboard focus show them, and they
 * hide again after OVERLAY_SHOW_MS. `dismissed` is a hide the person asked for,
 * which also holds over a paused video.
 */
export function useTouchOverlay(resetKey: string) {
  const [active, setActive] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const gesture = useRef<{ id: number; x: number; y: number; moved: boolean; control: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const clickTimer = useRef<number | undefined>(undefined);
  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    setActive(true);
    setDismissed(false);
    timer.current = window.setTimeout(() => setActive(false), OVERLAY_SHOW_MS);
  }, []);
  const toggle = useCallback(() => {
    if (!active) {
      show();
      return;
    }
    window.clearTimeout(timer.current);
    setActive(false);
    setDismissed(true);
  }, [active, show]);

  useEffect(() => {
    gesture.current = null;
    show();
    return () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(clickTimer.current);
    };
  }, [resetKey, show]);

  const onPointerDownCapture = useCallback(
    (event: PointerEvent) => {
      if (event.pointerType !== 'touch' && event.pointerType !== 'mouse') return;
      // A mouse clicks the picture only: everything else on the page is its own control.
      if (event.pointerType === 'mouse' && !(event.target as Element).closest('.file-detail-media-wrap')) {
        gesture.current = null;
        return;
      }
      const control = Boolean((event.target as Element).closest(OVERLAY_CONTROL));
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, control };
      if (control && event.pointerType === 'touch') {
        window.clearTimeout(timer.current);
        setActive(true);
      }
    },
    []
  );
  const onPointerUpCapture = useCallback(
    (event: PointerEvent) => {
      const touch = gesture.current;
      if (!touch || touch.id !== event.pointerId) return;
      gesture.current = null;
      if (touch.control) {
        show();
        return;
      }
      if (touch.moved || swipeAxis(event.clientX - touch.x, event.clientY - touch.y) !== 'idle') return;
      if (event.pointerType === 'touch') {
        toggle();
        return;
      }
      // The second click of a double click: that is the page's (fullscreen) or the video's (skip).
      if (clickTimer.current !== undefined) {
        window.clearTimeout(clickTimer.current);
        clickTimer.current = undefined;
        return;
      }
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = undefined;
        toggle();
      }, DOUBLE_CLICK_MS);
    },
    [show, toggle]
  );
  const onPointerCancelCapture = useCallback(
    (event: PointerEvent) => {
      if (gesture.current?.id !== event.pointerId) return;
      const control = gesture.current.control;
      gesture.current = null;
      if (control) show();
    },
    [show]
  );
  const onPointerActivity = useCallback(
    (event: PointerEvent) => {
      const pressed = gesture.current?.id === event.pointerId ? gesture.current : null;
      if (pressed) {
        if (swipeAxis(event.clientX - pressed.x, event.clientY - pressed.y) !== 'idle') pressed.moved = true;
      } else if (event.pointerType === 'mouse') {
        show();
      }
    },
    [show]
  );
  return { active, dismissed, show, onPointerDownCapture, onPointerUpCapture, onPointerCancelCapture, onPointerActivity };
}
