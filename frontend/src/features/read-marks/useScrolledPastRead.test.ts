// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushReadQueue } from './readQueue';
import {
  averageRowHeight,
  readerMovedPast,
  useScrolledPastRead
} from './useScrolledPastRead';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const markRead = vi.fn();

vi.mock('@/api', () => ({
  api: { markRead: (...args: unknown[]) => markRead(...args) },
  API_BASE: '/api'
}));

const rect = (top: number, bottom: number): DOMRect =>
  ({
    x: 0,
    y: top,
    width: 220,
    height: bottom - top,
    top,
    right: 220,
    bottom,
    left: 0,
    toJSON: () => ({})
  }) as DOMRect;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

const installScrollEnvironment = (
  initialScrollY: number,
  initiallyIntersecting: boolean
) => {
  let scrollY = initialScrollY;
  let cardBounds = rect(100, 300);
  let runFrame = () => {};
  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    get: () => scrollY
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.readKey ? cardBounds : rect(0, 220);
    }
  );
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    runFrame = () => callback(0);
    return 1;
  });

  class InitialOnlyIntersectionObserver {
    private readonly callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element) {
      this.callback(
        [
          {
            target,
            isIntersecting: initiallyIntersecting,
            boundingClientRect: initiallyIntersecting
              ? rect(100, 300)
              : rect(1_000, 1_200),
            rootBounds: rect(-440, 800)
          } as IntersectionObserverEntry
        ],
        this as unknown as IntersectionObserver
      );
    }

    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }

  vi.stubGlobal('IntersectionObserver', InitialOnlyIntersectionObserver);
  return {
    arm: () => window.dispatchEvent(new PointerEvent('pointerdown')),
    runFrame: () => runFrame(),
    scrollTo: (nextScrollY: number, nextCardBounds: DOMRect) => {
      scrollY = nextScrollY;
      cardBounds = nextCardBounds;
      window.dispatchEvent(new Event('scroll'));
    }
  };
};

function Harness() {
  const gridRef = useScrolledPastRead('post', true, 1, 1);
  return createElement(
    'div',
    { ref: gridRef },
    createElement('div', { 'data-read-key': 'site:one' })
  );
}

const renderHarness = async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(Harness)));
};

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  markRead.mockReset();
  markRead.mockResolvedValue({ marked: 1 });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

it('marks a seen card from a touch scroll when the observer misses its exit', async () => {
  const scroll = installScrollEnvironment(0, true);
  await renderHarness();

  scroll.arm();
  scroll.scrollTo(1_000, rect(-700, -500));
  scroll.scrollTo(0, rect(100, 300));
  scroll.runFrame();
  await flushReadQueue();

  expect(markRead).toHaveBeenCalledWith('post', ['site:one']);
});

it('does not mark a newly seen card while scrolling up from a restored offset', async () => {
  const scroll = installScrollEnvironment(2_000, false);
  await renderHarness();

  scroll.arm();
  scroll.scrollTo(0, rect(100, 300));
  scroll.runFrame();
  await flushReadQueue();

  expect(markRead).not.toHaveBeenCalled();
});
