// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  anchoredScrollTarget,
  restoreScrollTo,
  withScrollAnchor
} from './restoreScrollTo';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('restoreScrollTo', () => {
  it('lets only the latest restore move the window', () => {
    let scrollY = 0;
    let now = 0;
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    vi.spyOn(window, 'scrollTo').mockImplementation((options) => {
      scrollY = Math.min(1_200, (options as ScrollToOptions).top ?? 0);
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));

    // A list offset the page on screen cannot reach, then the detail's top.
    const stopList = restoreScrollTo(4_000);
    const stopDetail = restoreScrollTo(0);
    for (; now <= 4_000; now += 16) {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((frame) => frame(now));
    }
    stopList();
    stopDetail();

    expect(scrollY).toBe(0);
  });
});

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
