import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

/** How long media controls stay visible after the latest pointer activity. */
export const OVERLAY_SHOW_MS = 3000;

const OVERLAY_CONTROL =
  '.file-detail-overlay-btn, .file-detail-overlay-row, .file-detail-overlay-actions, .video-controls';

/** Hover and keyboard focus keep controls visible; pointer activity renews the timer. */
export function useTouchOverlay(resetKey: string) {
  const [active, setActive] = useState(true);
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
    show();
    return () => window.clearTimeout(timer.current);
  }, [resetKey, show]);

  const onPointerDownCapture = useCallback(
    (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      if ((event.target as Element).closest(OVERLAY_CONTROL)) {
        window.clearTimeout(timer.current);
        setActive(true);
      } else if (active) hide();
      else show();
    },
    [active, hide, show]
  );
  const onPointerUpCapture = useCallback(
    (event: PointerEvent) => {
      if (event.pointerType === 'touch' && (event.target as Element).closest(OVERLAY_CONTROL)) show();
    },
    [show]
  );
  const onPointerActivity = useCallback(
    (event: PointerEvent) => {
      if (event.pointerType === 'mouse') show();
    },
    [show]
  );
  return { active, onPointerDownCapture, onPointerUpCapture, onPointerActivity };
}
