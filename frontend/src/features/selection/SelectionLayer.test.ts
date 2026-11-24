import { describe, expect, it } from 'vitest';

import { fillOrigin, joins, squareCorners } from './SelectionLayer';

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
  const tile = box(108, 108);
  const none = { topLeft: false, topRight: false, bottomRight: false, bottomLeft: false };

  it('keeps every corner round without selected neighbours', () => {
    expect(squareCorners(tile, [box(400, 108)], 8)).toEqual(none);
  });

  it('squares the corners a taller neighbour beside it reaches past', () => {
    expect(squareCorners(tile, [box(216, 50, 100, 200)], 8)).toEqual({ ...none, topRight: true, bottomRight: true });
  });

  it('keeps round the corner of a T-junction a shorter neighbour stops short of', () => {
    expect(squareCorners(tile, [box(216, 150, 100, 100)], 8)).toEqual({ ...none, bottomRight: true });
  });
});

describe('joins', () => {
  const tile = (left: number, top: number, height: number) => ({ box: box(left, top, 100, height), radius: 12 });

  it('adds none between neighbours that end level, or tiles too far apart', () => {
    expect(joins([tile(0, 0, 100), tile(108, 0, 100)], 8)).toEqual([]);
    expect(joins([tile(0, 0, 100), tile(300, 0, 200)], 8)).toEqual([]);
  });

  it('rounds the inner corner under the shorter neighbour, centred on a tile there', () => {
    // The tile under the left one would start at (0, 108); its rounded corner is centred at (88, 120).
    expect(joins([tile(0, 0, 100), tile(108, 0, 200)], 8)).toEqual(['M104,104V120A16,16 0 0 0 88,104Z']);
  });

  it('keeps the fillet within a step shorter than its radius', () => {
    expect(joins([tile(0, 0, 100), tile(108, 0, 105)], 8)).toEqual(['M104,104V109A5,5 0 0 0 99,104Z']);
  });
});
