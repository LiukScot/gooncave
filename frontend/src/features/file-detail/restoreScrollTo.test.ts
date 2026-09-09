import { describe, expect, it } from 'vitest';

import { anchoredScrollTarget, withScrollAnchor } from './restoreScrollTo';

describe('anchoredScrollTarget', () => {
  it('settles after following a tile moved by masonry layout', () => {
    expect(
      anchoredScrollTarget({
        savedScrollY: 1_200,
        savedViewportTop: 180,
        currentScrollY: 0,
        currentViewportTop: 1_460
      })
    ).toBe(1_280);

    expect(
      anchoredScrollTarget({
        savedScrollY: 1_200,
        savedViewportTop: 180,
        currentScrollY: 1_280,
        currentViewportTop: 180
      })
    ).toBe(1_280);
  });

  it('keeps the saved offset when no anchor is available', () => {
    expect(
      anchoredScrollTarget({
        savedScrollY: 1_200,
        savedViewportTop: null,
        currentScrollY: 0,
        currentViewportTop: null
      })
    ).toBe(1_200);
  });

  it('changes the return tile without losing its viewport position', () => {
    expect(
      withScrollAnchor(
        { scrollY: 1_200, anchorId: 'first', viewportTop: 180 },
        'last-opened'
      )
    ).toEqual({
      scrollY: 1_200,
      anchorId: 'last-opened',
      viewportTop: 180
    });
  });
});
