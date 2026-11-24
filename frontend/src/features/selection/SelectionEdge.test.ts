import { describe, expect, it } from 'vitest';

import { fillOrigin, squareCorners } from './SelectionEdge';

const box = (left: number, top: number, width = 100, height = 100) =>
  ({ left, top, right: left + width, bottom: top + height });

describe('fillOrigin', () => {
  const tile = box(108, 108);

  it('fills evenly without selected neighbours, and ignores tiles further than the gap', () => {
    expect(fillOrigin(tile, [box(400, 108)], 8)).toEqual({ x: 0, y: 0 });
  });

  it('starts from the side with the most selected neighbours along it', () => {
    expect(fillOrigin(tile, [box(0, 108), box(216, 108, 100, 30)], 8)).toEqual({ x: -1, y: 0 });
    expect(fillOrigin(tile, [box(108, 216)], 8)).toEqual({ x: 0, y: 1 });
  });

  it('starts from the corner between two sides with neighbours', () => {
    expect(fillOrigin(tile, [box(216, 108), box(108, 0)], 8)).toEqual({ x: 1, y: -1 });
  });

  it('does not count a tile that only touches a corner', () => {
    expect(fillOrigin(tile, [box(0, 0)], 8)).toEqual({ x: 0, y: 0 });
  });
});

describe('squareCorners', () => {
  const none = { topLeft: false, topRight: false, bottomRight: false, bottomLeft: false };

  it('keeps every corner round on a tile alone', () => {
    expect(squareCorners(box(108, 108), [], 8)).toEqual(none);
  });

  it('squares the corners a taller neighbour reaches past, so no notch is left between them', () => {
    expect(squareCorners(box(108, 108), [box(216, 50, 100, 300)], 8))
      .toEqual({ ...none, topRight: true, bottomRight: true });
  });

  it('keeps round the corner a shorter neighbour stops short of', () => {
    expect(squareCorners(box(108, 108), [box(216, 150, 100, 300)], 8))
      .toEqual({ ...none, bottomRight: true });
  });
});
