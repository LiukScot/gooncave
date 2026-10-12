// @vitest-environment happy-dom

import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  rememberListPlace,
  seedListPlace,
  useWindowScrollScreen,
  type ScrollScreen
} from './windowScroll';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;
let scrollY = 0;
let maxScrollY = 10_000;
let now = 0;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

beforeEach(() => {
  scrollY = 0;
  maxScrollY = 10_000;
  now = 0;
  frames = new Map();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
  vi.spyOn(window, 'scrollTo').mockImplementation((options) => {
    const top = (options as ScrollToOptions).top ?? 0;
    scrollY = Math.min(maxScrollY, Math.max(0, top));
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const runFrames = (ms: number) => {
  const end = now + ms;
  for (; now <= end; now += 16) {
    const pending = [...frames.values()];
    frames.clear();
    act(() => pending.forEach((frame) => frame(now)));
  }
};

function Screen({ screen }: { screen: ScrollScreen | null }) {
  useWindowScrollScreen(screen);
  return null;
}

const show = (...screens: (ScrollScreen | null)[]) =>
  act(() =>
    root?.render(
      <>
        {screens.map((screen, index) => (
          <Screen key={screen?.key ?? `none-${index}`} screen={screen} />
        ))}
      </>
    )
  );

describe('useWindowScrollScreen', () => {
  it('resets a replacement detail before its layout effects run', () => {
    const seenDuringLayout: number[] = [];
    function Detail({ id }: { id: string }) {
      useWindowScrollScreen({ kind: 'detail', key: id });
      useLayoutEffect(() => {
        seenDuringLayout.push(scrollY);
      }, [id]);
      return null;
    }
    act(() => root?.render(<Detail id="parent" />));
    scrollY = 900;
    act(() => root?.render(<Detail id="child" />));

    expect(seenDuringLayout).toEqual([0, 0]);
  });

  it('holds the top while the detail lays out', () => {
    show({ kind: 'detail', key: 'post' });
    scrollY = 900;
    runFrames(100);

    expect(scrollY).toBe(0);
  });

  it('lets keyboard scrolling take over after a detail opens', () => {
    show({ kind: 'detail', key: 'post' });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
    scrollY = 300;
    runFrames(100);

    expect(scrollY).toBe(300);
  });

  it('keeps a detail at the top when the page that opened it is left', () => {
    // The gallery opens a file from deep in its grid, then a related post
    // opens in explore: the gallery screens go away with their route.
    show({ kind: 'list', key: 'gallery-left' });
    scrollY = 4_000;
    rememberListPlace('gallery-left');
    show({ kind: 'detail', key: 'file' });
    maxScrollY = 1_200;
    show({ kind: 'detail', key: 'related-post' });
    runFrames(4_000);

    expect(scrollY).toBe(0);
  });

  it('returns a list to its place when its detail closes', () => {
    show({ kind: 'list', key: 'grid-return' });
    scrollY = 2_000;
    rememberListPlace('grid-return');
    show({ kind: 'detail', key: 'file' });
    runFrames(100);
    show({ kind: 'list', key: 'grid-return' });
    runFrames(100);

    expect(scrollY).toBe(2_000);
  });

  it('brings the opened tile back to the same height after a reflow', () => {
    const tile = document.createElement('div');
    tile.dataset.detailAnchor = 'tile';
    document.body.append(tile);
    let tileTop = 300;
    vi.spyOn(tile, 'getBoundingClientRect').mockImplementation(
      () => ({ top: tileTop - scrollY }) as DOMRect
    );
    show({ kind: 'list', key: 'grid-anchor' });
    scrollY = 200;
    rememberListPlace('grid-anchor', 'tile');
    show({ kind: 'detail', key: 'tile' });
    tileTop = 700;
    show({ kind: 'list', key: 'grid-anchor' });
    runFrames(100);

    expect(scrollY).toBe(600);
  });

  it('leaves the window alone for a list with no place', () => {
    scrollY = 500;
    show({ kind: 'list', key: 'grid-fresh' });
    runFrames(100);

    expect(scrollY).toBe(500);
  });

  it('applies a seeded place only once its list is on screen', () => {
    show({ kind: 'detail', key: 'post' });
    seedListPlace('grid-seeded', 1_500);
    runFrames(100);
    expect(scrollY).toBe(0);

    show({ kind: 'list', key: 'grid-seeded' });
    runFrames(100);
    expect(scrollY).toBe(1_500);
  });

  it('moves the window when a list on screen is seeded', () => {
    show({ kind: 'list', key: 'grid-remount' });
    seedListPlace('grid-remount', 1_500);
    runFrames(100);

    expect(scrollY).toBe(1_500);
  });

  it('records the reader scrolling a list, not a detail', () => {
    show({ kind: 'list', key: 'grid-record' });
    window.dispatchEvent(new Event('touchstart'));
    scrollY = 800;
    window.dispatchEvent(new Event('scroll'));
    show({ kind: 'detail', key: 'file' });
    window.dispatchEvent(new Event('touchstart'));
    scrollY = 50;
    window.dispatchEvent(new Event('scroll'));
    show({ kind: 'list', key: 'grid-record' });
    runFrames(100);

    expect(scrollY).toBe(800);
  });
});
