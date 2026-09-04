import { describe, expect, it } from 'vitest';

import { swipeAxis, swipeVerdict } from './useDetailSwipe';

const WIDTH = 400;
/** 22% of WIDTH, the distance rule, well under the 140px cap. */
const SLOW = 1000;

describe('swipeVerdict', () => {
  it('ignores a drag that never leaves the current item', () => {
    expect(swipeVerdict(40, SLOW, WIDTH)).toBe(0);
    expect(swipeVerdict(-40, SLOW, WIDTH)).toBe(0);
  });

  it('moves back on a long drag to the right', () => {
    expect(swipeVerdict(120, SLOW, WIDTH)).toBe(-1);
  });

  it('moves on on a long drag to the left', () => {
    expect(swipeVerdict(-120, SLOW, WIDTH)).toBe(1);
  });

  it('takes a short fling as a full swipe', () => {
    expect(swipeVerdict(40, 50, WIDTH)).toBe(-1);
    expect(swipeVerdict(-40, 50, WIDTH)).toBe(1);
  });

  it('keeps a fling under the minimum distance as a tap', () => {
    expect(swipeVerdict(20, 20, WIDTH)).toBe(0);
  });

  it('caps the distance rule so a wide frame stays reachable', () => {
    expect(swipeVerdict(150, SLOW, 4000)).toBe(-1);
  });

  it('survives a zero-length gesture', () => {
    expect(swipeVerdict(0, 0, WIDTH)).toBe(0);
  });
});

describe('swipeAxis', () => {
  it('waits until one axis has moved far enough to tell', () => {
    expect(swipeAxis(0, 0)).toBe('idle');
    expect(swipeAxis(7, 7)).toBe('idle');
    expect(swipeAxis(-7, 7)).toBe('idle');
  });

  it('takes a clearly sideways drag as a swipe', () => {
    expect(swipeAxis(40, 9)).toBe('x');
    expect(swipeAxis(-40, 9)).toBe('x');
    expect(swipeAxis(9, 0)).toBe('x');
  });

  it('takes a clearly upward drag as a scroll', () => {
    expect(swipeAxis(0, -40)).toBe('y');
    expect(swipeAxis(3, 30)).toBe('y');
  });

  // Regression: a thumb flicking the page up arcs sideways, and the old rule
  // read 10px across against 8px up as a horizontal swipe. The scroll was
  // swallowed and the picture slid back on release.
  it('reads a thumb arc as a scroll, not a swipe', () => {
    expect(swipeAxis(10, -8)).toBe('y');
    expect(swipeAxis(12, -9)).toBe('y');
    expect(swipeAxis(-10, -8)).toBe('y');
  });

  it('never commits to x on horizontal travel under the threshold', () => {
    expect(swipeAxis(6, -30)).toBe('y');
  });
});
