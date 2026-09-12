import { describe, expect, it } from 'vitest';

import { passedAboveTop } from './passedAboveTop';

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
