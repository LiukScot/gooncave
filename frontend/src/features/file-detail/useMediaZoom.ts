import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DOUBLE_TAP_ZOOM,
  isZoomed,
  NO_ZOOM,
  panBy,
  pinchWheelDelta,
  pinchZoom,
  zoomAtPointer,
  zoomInAt,
  zoomTransform,
  type ZoomState
} from './mediaZoom';

type Point = { x: number; y: number };

type Pinch = {
  start: ZoomState;
  distance: number;
  mid: Point;
};

const distanceBetween = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** The midpoint of two fingers, measured from the centre of the box. */
const midpoint = (a: Point, b: Point, rect: DOMRect): Point => ({
  x: (a.x + b.x) / 2 - rect.left - rect.width / 2,
  y: (a.y + b.y) / 2 - rect.top - rect.height / 2
});

const startPinch = (
  pointers: Map<number, Point>,
  start: ZoomState,
  rect: DOMRect
): Pinch => {
  const [a, b] = [...pointers.values()];
  return { start, distance: distanceBetween(a, b), mid: midpoint(a, b, rect) };
};

/**
 * Zoom for the fullscreen viewer: the wheel and a mouse drag on a computer,
 * a pinch and a one-finger drag on a touch screen.
 *
 * Only while fullscreen: everywhere else the wheel scrolls the page. The
 * picture is scaled inside the viewer rather than by the browser's own page
 * zoom, so the exit button stays on screen at any magnification. The state
 * resets whenever the viewer is left or the file changes, so a picture never
 * opens already half off screen.
 */
export const useMediaZoom = (enabled: boolean, resetKey: string | null) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<ZoomState>(NO_ZOOM);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Every pointer pressed on the picture, by id, at its last position.
  const pointersRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<Pinch | null>(null);

  useEffect(() => {
    setZoom(NO_ZOOM);
    pointersRef.current.clear();
    pinchRef.current = null;
  }, [enabled, resetKey]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!enabled || !wrap) return;
    // Registered by hand rather than through onWheel: React attaches wheel
    // listeners passively, and a passive listener cannot stop the page from
    // scrolling underneath the zoom.
    // A touchpad pinch arrives as a wheel with Ctrl held (Ctrl and a mouse wheel too): it zooms.
    // Two fingers sliding on the touchpad, or a plain wheel, move a zoomed picture.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = wrap.getBoundingClientRect();
      if (!event.ctrlKey) {
        setZoom((current) =>
          isZoomed(current) ? panBy(current, { x: -event.deltaX, y: -event.deltaY }, rect) : current
        );
        return;
      }
      setZoom((current) =>
        zoomAtPointer(
          current,
          pinchWheelDelta(event.deltaY),
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
      if (!enabled || event.button > 0) return;
      // A mouse drag only pans; with nothing to pan it is left to the page.
      if (event.pointerType === 'mouse' && !isZoomed(zoomRef.current)) return;
      // Buttons keep their own taps.
      if ((event.target as HTMLElement).closest('button, input, a')) return;
      // The first finger of a new gesture: forget any finger whose lift
      // never reached us, or it would turn this touch into a pinch.
      if (event.isPrimary) pointersRef.current.clear();
      pointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY
      });
      // Touch is captured to the touched element already; capturing it to
      // the wrap would move the tap's click onto the letterboxing, which
      // leaves fullscreen.
      if (event.pointerType === 'mouse') {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      if (pointersRef.current.size === 2) {
        pinchRef.current = startPinch(
          pointersRef.current,
          zoomRef.current,
          event.currentTarget.getBoundingClientRect()
        );
      }
    },
    [enabled]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pointers = pointersRef.current;
      const from = pointers.get(event.pointerId);
      if (!from) return;
      const to = { x: event.clientX, y: event.clientY };
      pointers.set(event.pointerId, to);
      const rect = event.currentTarget.getBoundingClientRect();
      const pinch = pinchRef.current;
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        setZoom(
          pinchZoom(
            pinch.start,
            pinch.distance,
            distanceBetween(a, b),
            pinch.mid,
            midpoint(a, b, rect),
            rect
          )
        );
        return;
      }
      // One finger on a picture at 1:1 is a swipe to the next file, which
      // useDetailSwipe handles.
      if (!isZoomed(zoomRef.current)) return;
      setZoom((current) =>
        panBy(current, { x: to.x - from.x, y: to.y - from.y }, rect)
      );
    },
    []
  );

  const onPointerEnd = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pointers = pointersRef.current;
      if (!pointers.delete(event.pointerId)) return;
      // Two fingers left of three: carry on pinching from here.
      pinchRef.current =
        pointers.size === 2
          ? startPinch(
              pointers,
              zoomRef.current,
              event.currentTarget.getBoundingClientRect()
            )
          : null;
    },
    []
  );

  // Chromium starts dragging the picture itself out of the page on a mouse
  // drag, which swallows the pointer moves that pan it.
  const onDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (enabled) event.preventDefault();
    },
    [enabled]
  );

  const reset = useCallback(() => setZoom(NO_ZOOM), []);

  /** Zooms in on the point of the picture under `client` (screen coordinates), in fullscreen. */
  const zoomInOn = useCallback(
    (client: Point) => {
      const wrap = wrapRef.current;
      if (!enabled || !wrap) return;
      const rect = wrap.getBoundingClientRect();
      setZoom(
        zoomInAt(
          DOUBLE_TAP_ZOOM,
          { x: client.x - rect.left - rect.width / 2, y: client.y - rect.top - rect.height / 2 },
          rect
        )
      );
    },
    [enabled]
  );

  return {
    wrapRef,
    zoomed: isZoomed(zoom),
    transform: isZoomed(zoom) ? zoomTransform(zoom) : undefined,
    reset,
    zoomInOn,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onDragStart
    }
  };
};
