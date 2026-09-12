import { describe, expect, it } from 'vitest';

import { passedAboveTop } from './passedAboveTop';
import {
  averageRowHeight,
  readerMovedPast
} from './useScrolledPastRead';

/**
 * The observer grows its root 440px (two 220px rows) above the viewport, so
 * `rootBounds.top` is -440 while the window's own top is 0.
 */
const ROOT_TOP = -440;

const entry = (
  bottom: number,
  isIntersecting: boolean,
  rootTop: number | null = ROOT_TOP
) =>
  ({
    isIntersecting,
    boundingClientRect: { bottom } as DOMRectReadOnly,
    rootBounds: rootTop === null ? null : ({ top: rootTop } as DOMRectReadOnly)
  }) as IntersectionObserverEntry;

describe('passedAboveTop', () => {
  it('marks a card that has cleared the grown root', () => {
    expect(passedAboveTop(entry(-500, false))).toBe(true);
  });

  it('leaves a card still on screen alone', () => {
    expect(passedAboveTop(entry(400, true))).toBe(false);
  });

  it('leaves a card that is only just above the viewport alone', () => {
    // Scrolled out of sight but not yet two rows back.
    expect(passedAboveTop(entry(-200, false))).toBe(false);
  });

  it('leaves a card below the fold alone', () => {
    expect(passedAboveTop(entry(4000, false))).toBe(false);
  });

  it('marks nothing when the root cannot be measured', () => {
    expect(passedAboveTop(entry(-500, false, null))).toBe(false);
  });
});

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
