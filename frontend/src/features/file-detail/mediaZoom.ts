export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

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
  const next = clamp(state.scale * Math.exp(-deltaY / 400), MIN_ZOOM, MAX_ZOOM);
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

export const panBy = (
  state: ZoomState,
  delta: { x: number; y: number },
  box: { width: number; height: number }
): ZoomState =>
  clampOffset(
    { scale: state.scale, x: state.x + delta.x, y: state.y + delta.y },
    box
  );

export const zoomTransform = (state: ZoomState): string =>
  `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
