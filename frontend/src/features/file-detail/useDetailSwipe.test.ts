import { describe, expect, it } from 'vitest';

import { swipeVerdict } from './useDetailSwipe';

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
