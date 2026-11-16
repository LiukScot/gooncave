import { describe, expect, it } from 'vitest';

import {
  clampOffset,
  isZoomed,
  MAX_ZOOM,
  NO_ZOOM,
  panBy,
  pinchWheelDelta,
  pinchZoom,
  zoomAtPointer,
  zoomTransform
} from './mediaZoom';

const box = { width: 1000, height: 800 };

describe('zoomAtPointer', () => {
  it('zooms in on a wheel up and out on a wheel down', () => {
    const zoomedIn = zoomAtPointer(NO_ZOOM, -100, { x: 0, y: 0 }, box);
    expect(zoomedIn.scale).toBeGreaterThan(1);
    expect(zoomAtPointer(zoomedIn, 100, { x: 0, y: 0 }, box).scale).toBeCloseTo(
      1
    );
  });

  it('never goes below 1:1 or past the ceiling', () => {
    expect(zoomAtPointer(NO_ZOOM, 500, { x: 0, y: 0 }, box)).toEqual(NO_ZOOM);
    let state = NO_ZOOM;
    for (let i = 0; i < 50; i += 1) {
      state = zoomAtPointer(state, -200, { x: 0, y: 0 }, box);
    }
    expect(state.scale).toBe(MAX_ZOOM);
  });

  it('keeps the point under the cursor in place', () => {
    const pointer = { x: 200, y: -100 };
    const before = { scale: 1.5, x: 40, y: -20 };
    // The content point the pointer sits over, measured before the zoom.
    // Deriving it from the state afterwards would be an identity that a
    // centre-anchored implementation passes just as happily.
    const content = {
      x: (pointer.x - before.x) / before.scale,
      y: (pointer.y - before.y) / before.scale
    };

    const after = zoomAtPointer(before, -100, pointer, box);

    expect(content.x * after.scale + after.x).toBeCloseTo(pointer.x);
    expect(content.y * after.scale + after.y).toBeCloseTo(pointer.y);
  });

  it('returns to a clean state on the way back to 1:1', () => {
    let state = zoomAtPointer(NO_ZOOM, -100, { x: 300, y: 200 }, box);
    state = zoomAtPointer(state, 1000, { x: 300, y: 200 }, box);
    expect(state).toEqual(NO_ZOOM);
  });
});

describe('clampOffset', () => {
  it('allows no movement at 1:1', () => {
    expect(clampOffset({ scale: 1, x: 400, y: 400 }, box)).toEqual({
      scale: 1,
      x: 0,
      y: 0
    });
  });

  it('stops the picture being dragged off screen', () => {
    // At 2x the overflow is one full box, so half of it each way.
    expect(clampOffset({ scale: 2, x: 9999, y: -9999 }, box)).toEqual({
      scale: 2,
      x: 500,
      y: -400
    });
  });
});

describe('panBy', () => {
  it('moves by the drag and stays inside the bounds', () => {
    expect(panBy({ scale: 2, x: 0, y: 0 }, { x: 50, y: -20 }, box)).toEqual({
      scale: 2,
      x: 50,
      y: -20
    });
    expect(panBy({ scale: 2, x: 480, y: 0 }, { x: 100, y: 0 }, box).x).toBe(
      500
    );
  });
});

describe('pinchZoom', () => {
  it('scales by how far the fingers spread', () => {
    const state = pinchZoom(NO_ZOOM, 100, 250, { x: 0, y: 0 }, { x: 0, y: 0 }, box);
    expect(state.scale).toBeCloseTo(2.5);
  });

  it('keeps the picture point between the fingers under them as they move', () => {
    const start = { scale: 2, x: 100, y: -50 };
    const startMid = { x: 150, y: 30 };
    const mid = { x: 120, y: 60 };
    // Content point under the fingers when the pinch began.
    const content = {
      x: (startMid.x - start.x) / start.scale,
      y: (startMid.y - start.y) / start.scale
    };
    const state = pinchZoom(start, 100, 150, startMid, mid, box);
    expect(state.x + content.x * state.scale).toBeCloseTo(mid.x);
    expect(state.y + content.y * state.scale).toBeCloseTo(mid.y);
  });

  it('lands back at rest when pinched below 1:1', () => {
    expect(
      pinchZoom({ scale: 1.5, x: 40, y: 0 }, 200, 50, { x: 0, y: 0 }, { x: 0, y: 0 }, box)
    ).toEqual(NO_ZOOM);
  });
});

describe('isZoomed / zoomTransform', () => {
  it('reports the resting state as not zoomed', () => {
    expect(isZoomed(NO_ZOOM)).toBe(false);
    expect(isZoomed({ scale: 1.2, x: 0, y: 0 })).toBe(true);
  });

  it('renders a transform the browser understands', () => {
    expect(zoomTransform({ scale: 2, x: 10, y: -5 })).toBe(
      'translate(10px, -5px) scale(2)'
    );
  });
});

describe('pinchWheelDelta', () => {
  it('speeds up the small steps of a pinch but keeps a mouse notch one step', () => {
    expect(pinchWheelDelta(-5)).toBe(-20);
    expect(pinchWheelDelta(120)).toBe(100);
    expect(pinchWheelDelta(-120)).toBe(-100);
  });
});
