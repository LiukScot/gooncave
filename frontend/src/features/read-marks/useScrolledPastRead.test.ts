import { describe, expect, it } from 'vitest';

import { averageRowHeight, readerMovedPast } from './useScrolledPastRead';

describe('averageRowHeight', () => {
  it('averages the whole grid rather than one tile', () => {
    // 10 rows of 3 columns, grid 2500px tall → 250px a row.
    expect(averageRowHeight(2500, 30, 3)).toBe(250);
  });

  it('falls back when the grid has not laid out yet', () => {
    expect(averageRowHeight(0, 30, 3)).toBe(220);
    expect(averageRowHeight(2500, 0, 3)).toBe(220);
    expect(averageRowHeight(2500, 30, 0)).toBe(220);
  });
});

describe('readerMovedPast', () => {
  it('counts a card the reader scrolled beyond', () => {
    expect(readerMovedPast(0, 900)).toBe(true);
  });

  it('ignores a card that rode up while the reader stood still', () => {
    // Toggling the filter re-lengths the list; the page never moved.
    expect(readerMovedPast(3000, 3000)).toBe(false);
  });

  it('ignores a card carried up by the page getting shorter', () => {
    expect(readerMovedPast(3000, 2400)).toBe(false);
  });

  it('ignores a card this observer never had in view', () => {
    expect(readerMovedPast(undefined, 5000)).toBe(false);
  });
});
