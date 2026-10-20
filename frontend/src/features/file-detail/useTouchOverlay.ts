import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

import { swipeAxis } from './useDetailSwipe';

/** How long media controls stay visible after the latest pointer activity. */
export const OVERLAY_SHOW_MS = 4000;

const OVERLAY_CONTROL =
  '.file-detail-overlay-btn, .file-detail-overlay-row, .file-detail-overlay-actions, .video-controls';

/** Hover and keyboard focus keep controls visible; pointer activity renews the timer. */
export function useTouchOverlay(resetKey: string) {
  const [active, setActive] = useState(true);
  const gesture = useRef<{ id: number; x: number; y: number; moved: boolean; control: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setActive(false);
  }, []);
  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    setActive(true);
    timer.current = window.setTimeout(() => setActive(false), OVERLAY_SHOW_MS);
  }, []);

  useEffect(() => {
    gesture.current = null;
    show();
    return () => window.clearTimeout(timer.current);
  }, [resetKey, show]);

  const onPointerDownCapture = useCallback(
    (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      const control = Boolean((event.target as Element).closest(OVERLAY_CONTROL));
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, control };
      if (control) {
        window.clearTimeout(timer.current);
        setActive(true);
      }
    },
    []
  );
  const onPointerUpCapture = useCallback(
    (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      const touch = gesture.current;
      if (!touch || touch.id !== event.pointerId) return;
      gesture.current = null;
      if (touch.control) show();
      else if (!touch.moved && swipeAxis(event.clientX - touch.x, event.clientY - touch.y) === 'idle') {
        if (active) hide();
        else show();
      }
    },
    [active, hide, show]
  );
  const onPointerCancelCapture = useCallback(
    (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || gesture.current?.id !== event.pointerId) return;
      const control = gesture.current.control;
      gesture.current = null;
      if (control) show();
    },
    [show]
  );
  const onPointerActivity = useCallback(
    (event: PointerEvent) => {
      if (event.pointerType === 'mouse') show();
      else if (event.pointerType === 'touch' && gesture.current?.id === event.pointerId) {
        const touch = gesture.current;
        if (swipeAxis(event.clientX - touch.x, event.clientY - touch.y) !== 'idle') touch.moved = true;
      }
    },
    [show]
  );
  return { active, show, onPointerDownCapture, onPointerUpCapture, onPointerCancelCapture, onPointerActivity };
}
