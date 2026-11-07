export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
// Wheel notches per e-fold of magnification. Tuned so one notch is a clear
// but not jarring step on a mouse, and a trackpad flick lands somewhere
// sensible rather than at the ceiling.
const ZOOM_WHEEL_DIVISOR = 400;

export type ZoomState = {
  scale: number;
  x: number;
  y: number;
};

export const NO_ZOOM: ZoomState = { scale: 1, x: 0, y: 0 };

export const isZoomed = (state: ZoomState): boolean => state.scale > MIN_ZOOM;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * Keeps the offset inside what the zoom actually uncovers, so the picture
 * cannot be flung off screen and left there. The bound is half the overflow
 * on each axis, which is exact for content filling the box and generous for
 * the letterboxed rest — erring towards allowing a drag rather than fighting
 * one.
 */
export const clampOffset = (
  state: ZoomState,
  box: { width: number; height: number }
): ZoomState => {
  const limitX = (box.width * (state.scale - 1)) / 2;
  const limitY = (box.height * (state.scale - 1)) / 2;
  return {
    scale: state.scale,
    x: clamp(state.x, -limitX, limitX),
    y: clamp(state.y, -limitY, limitY)
  };
};

/**
 * One wheel notch, anchored on the pointer: the point of the picture under
 * the cursor stays under it. Zooming about the centre instead makes anything
 * off-centre run away from the cursor as it grows.
 *
 * `pointer` is measured from the centre of the box.
 */
export const zoomAtPointer = (
  state: ZoomState,
  deltaY: number,
  pointer: { x: number; y: number },
  box: { width: number; height: number }
): ZoomState => {
  // Exponential so every notch feels the same at any magnification; a fixed
  // step crawls when zoomed in and jumps when zoomed out.
  const next = clamp(
    state.scale * Math.exp(-deltaY / ZOOM_WHEEL_DIVISOR),
    MIN_ZOOM,
    MAX_ZOOM
  );
  if (next === state.scale) return state;
  if (next === MIN_ZOOM) return NO_ZOOM;

  const ratio = next / state.scale;
  return clampOffset(
    {
      scale: next,
      x: state.x * ratio + pointer.x * (1 - ratio),
      y: state.y * ratio + pointer.y * (1 - ratio)
    },
    box
  );
};

// A touchpad pinch reports small wheel steps; scaled up so the picture grows at the pace of the
// fingers rather than a quarter of it.
const PINCH_WHEEL_RATE = 4;
// About one mouse-wheel notch: the step ZOOM_WHEEL_DIVISOR is tuned for.
const WHEEL_NOTCH = 100;

/**
 * The zoom step of a wheel event with Ctrl held, for `zoomAtPointer`. A pinch's small steps are
 * scaled up; a mouse notch with Ctrl keeps its own size instead of jumping a whole e-fold.
 */
export const pinchWheelDelta = (deltaY: number): number =>
  clamp(deltaY * PINCH_WHEEL_RATE, -WHEEL_NOTCH, WHEEL_NOTCH);

/** How far a double tap zooms in. */
export const DOUBLE_TAP_ZOOM = 2.5;

/**
 * From 1:1 straight to `scale`, anchored on `point`: the part of the picture under the finger
 * stays under it. `point` is measured from the centre of the box.
 */
export const zoomInAt = (
  scale: number,
  point: { x: number; y: number },
  box: { width: number; height: number }
): ZoomState =>
  clampOffset({ scale, x: point.x * (1 - scale), y: point.y * (1 - scale) }, box);

export const panBy = (
  state: ZoomState,
  delta: { x: number; y: number },
  box: { width: number; height: number }
): ZoomState =>
  clampOffset(
    { scale: state.scale, x: state.x + delta.x, y: state.y + delta.y },
    box
  );

/**
 * A two-finger pinch, anchored between the fingers: the point of the picture
 * that sat under their midpoint when the pinch began follows the midpoint,
 * so the fingers both scale and drag the picture.
 *
 * `start` is the state when the second finger landed. Distances are in px;
 * midpoints are measured from the centre of the box.
 */
export const pinchZoom = (
  start: ZoomState,
  startDistance: number,
  distance: number,
  startMid: { x: number; y: number },
  mid: { x: number; y: number },
  box: { width: number; height: number }
): ZoomState => {
  const scale = clamp(
    (start.scale * distance) / Math.max(startDistance, 1),
    MIN_ZOOM,
    MAX_ZOOM
  );
  if (scale === MIN_ZOOM) return NO_ZOOM;
  const ratio = scale / start.scale;
  return clampOffset(
    {
      scale,
      x: mid.x - ratio * (startMid.x - start.x),
      y: mid.y - ratio * (startMid.y - start.y)
    },
    box
  );
};

export const zoomTransform = (state: ZoomState): string =>
  `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
