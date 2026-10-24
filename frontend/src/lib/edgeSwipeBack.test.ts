import { describe, expect, it } from 'vitest';

import { commitsSwipe } from './edgeSwipeBack';

describe('commitsSwipe', () => {
  it('commits past a third of the width however slowly', () => {
    expect(commitsSwipe(140, 375, 5000)).toBe(true);
  });

  it('keeps the page for a short, slow drag', () => {
    expect(commitsSwipe(60, 375, 2000)).toBe(false);
  });

  it('commits a short flick', () => {
    expect(commitsSwipe(60, 375, 80)).toBe(true);
  });

  it('ignores a flick that barely moved', () => {
    expect(commitsSwipe(10, 375, 5)).toBe(false);
  });
});
