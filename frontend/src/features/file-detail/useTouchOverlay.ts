import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

/** How long the buttons on a picture stay after a touch. */
export const OVERLAY_SHOW_MS = 3000;

const OVERLAY_CONTROL = '.file-detail-overlay-btn, .file-detail-overlay-row';

/**
 * The buttons on a picture appear on hover with a mouse. A phone has no hover,
 * and the browser keeps the last touched spot "hovered" forever, so the buttons
 * never left. A touch shows them for a few seconds; a touch away from them hides
 * them at once. `resetKey` is the open file: another file starts hidden.
 */
export function useTouchOverlay(resetKey: string) {
  const [active, setActive] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setActive(false);
  }, []);
  useEffect(() => hide, [resetKey, hide]);

  const onPointerDownCapture = useCallback(
    (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      if (active && !(event.target as Element).closest(OVERLAY_CONTROL)) return hide();
      window.clearTimeout(timer.current);
      setActive(true);
      timer.current = window.setTimeout(() => setActive(false), OVERLAY_SHOW_MS);
    },
    [active, hide]
  );
  return { active, onPointerDownCapture };
}
