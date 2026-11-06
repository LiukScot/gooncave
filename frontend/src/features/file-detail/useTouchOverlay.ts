import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';

import { swipeAxis } from './useDetailSwipe';
import { DOUBLE_TAP_MS } from './useDoubleTapFullscreen';

/** How long media controls stay visible after the latest pointer activity. */
export const OVERLAY_SHOW_MS = 4000;

// How long a mouse click waits to see that no second click, a double click, follows
// (a touch waits DOUBLE_TAP_MS).
// Shorter than the system's double-click interval would let slow double clicks
// through as two single clicks; longer makes the click feel late.
const DOUBLE_CLICK_MS = 250;

const OVERLAY_CONTROL =
  '.file-detail-overlay-btn, .video-controls';

/** Whether this press is on the Play button of a paused video, so it starts playback. */
const startsPlayback = (target: Element): boolean => {
  const play = target.closest('.video-controls-play');
  const video = play?.closest('.file-detail-media-wrap')?.querySelector('video');
  return Boolean(video?.paused);
};

/**
 * Whether the controls on the picture show. A tap or a click on the picture
 * shows or hides them, mouse movement and keyboard focus show them, and they
 * hide again after OVERLAY_SHOW_MS. `dismissed` is a hide the person asked for,
 * which also holds over a paused video.
 */
export function useTouchOverlay(resetKey: string) {
  const [active, setActive] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    moved: boolean;
    control: boolean;
  } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const clickTimer = useRef<number | undefined>(undefined);
  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    setActive(true);
    setDismissed(false);
    timer.current = window.setTimeout(() => setActive(false), OVERLAY_SHOW_MS);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setActive(false);
    setDismissed(false);
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
      const target = event.target as Element;
      const control = Boolean(target.closest(OVERLAY_CONTROL));
      gesture.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        moved: false,
        control
      };
      // Held on a control, the controls stay. They are not shown here: iOS drops the click of
      // a tap that makes something appear while the finger is down, as if it were a hover.
      if (control && event.pointerType === 'touch') window.clearTimeout(timer.current);
    },
    []
  );
  const onPointerUpCapture = useCallback(
    (event: PointerEvent) => {
      const touch = gesture.current;
      if (!touch || touch.id !== event.pointerId) return;
      gesture.current = null;
      if (touch.control) {
        // The controls show, or hide for Play, on the click that follows (onClickCapture).
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setActive(false), OVERLAY_SHOW_MS);
        return;
      }
      if (touch.moved || swipeAxis(event.clientX - touch.x, event.clientY - touch.y) !== 'idle') return;
      // The second tap or click of a double one: that is the page's (fullscreen) or the
      // video's (skip), and the controls stay as they were.
      if (clickTimer.current !== undefined) {
        window.clearTimeout(clickTimer.current);
        clickTimer.current = undefined;
        return;
      }
      clickTimer.current = window.setTimeout(
        () => {
          clickTimer.current = undefined;
          toggle();
        },
        event.pointerType === 'touch' ? DOUBLE_TAP_MS : DOUBLE_CLICK_MS
      );
    },
    [toggle]
  );
  const onClickCapture = useCallback(
    (event: MouseEvent) => {
      const target = event.target as Element;
      if (!target.closest(OVERLAY_CONTROL)) return;
      // From the keyboard (detail 0) the controls stay: the focused button would vanish.
      if (startsPlayback(target) && event.detail > 0) {
        // Play puts the controls away: the video is what the person wants to see. After the
        // button's own click, which runs next.
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(hide, 0);
        return;
      }
      show();
    },
    [hide, show]
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
  return {
    active,
    dismissed,
    show,
    onPointerDownCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
    onPointerActivity,
    onClickCapture
  };
}
