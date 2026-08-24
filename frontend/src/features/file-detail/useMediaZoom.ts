import { useCallback, useEffect, useRef, useState } from 'react';

import {
  isZoomed,
  NO_ZOOM,
  panBy,
  zoomAtPointer,
  zoomTransform,
  type ZoomState
} from './mediaZoom';

/**
 * Wheel zoom for the fullscreen viewer (issue #283).
 *
 * Only while fullscreen: everywhere else the wheel scrolls the page, and
 * taking that over would be worse than not zooming. Dragging pans once
 * zoomed, and the state resets whenever the viewer is left or the file
 * changes, so a picture never opens already half off screen.
 */
export const useMediaZoom = (enabled: boolean, resetKey: string | null) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<ZoomState>(NO_ZOOM);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setZoom(NO_ZOOM);
  }, [enabled, resetKey]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!enabled || !wrap) return;
    // Registered by hand rather than through onWheel: React attaches wheel
    // listeners passively, and a passive listener cannot stop the page from
    // scrolling underneath the zoom.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = wrap.getBoundingClientRect();
      setZoom((current) =>
        zoomAtPointer(
          current,
          event.deltaY,
          {
            x: event.clientX - rect.left - rect.width / 2,
            y: event.clientY - rect.top - rect.height / 2
          },
          rect
        )
      );
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [enabled]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Mouse only: touch already drives the swipe and the browser's own
      // pinch, and hijacking it here would fight both.
      if (!enabled || event.pointerType !== 'mouse') return;
      if (!isZoomed(zoom)) return;
      dragRef.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [enabled, zoom]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const from = dragRef.current;
      if (!from) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const delta = {
        x: event.clientX - from.x,
        y: event.clientY - from.y
      };
      dragRef.current = { x: event.clientX, y: event.clientY };
      setZoom((current) => panBy(current, delta, rect));
    },
    []
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const reset = useCallback(() => setZoom(NO_ZOOM), []);

  return {
    wrapRef,
    zoomed: isZoomed(zoom),
    transform: isZoomed(zoom) ? zoomTransform(zoom) : undefined,
    reset,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag
    }
  };
};
