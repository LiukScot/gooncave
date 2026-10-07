// @vitest-environment happy-dom

import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDetailScrollRestore } from './useDetailScrollRestore';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useDetailScrollRestore', () => {
  it('resets a replacement detail before its layout effects run', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const callsSeenDuringLayout: number[] = [];

    function Harness({ openKey }: { openKey: string }) {
      useDetailScrollRestore(openKey);
      useLayoutEffect(() => {
        callsSeenDuringLayout.push(scrollTo.mock.calls.length);
      }, [openKey]);
      return null;
    }

    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root?.render(<Harness openKey="parent" />));
    act(() => root?.render(<Harness openKey="child" />));

    expect(callsSeenDuringLayout).toEqual([1, 2]);
  });

  it('holds the top after the replacement detail grows during layout', () => {
    let scrollY = 0;
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {
      scrollY = 0;
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root?.render(<Harness openKey="parent" />));
    act(() => root?.render(<Harness openKey="child" />));
    scrollY = 900;
    act(() => frames.at(-1)?.(performance.now()));
    expect(scrollY).toBe(0);
  });

  it('lets keyboard scrolling take over after the detail opens', () => {
    let scrollY = 0;
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {
      scrollY = 0;
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    root = createRoot(document.createElement('div'));
    act(() => root?.render(<Harness openKey="post" />));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
    scrollY = 300;
    act(() => frames.at(-1)?.(performance.now()));

    expect(scrollY).toBe(300);
  });

  it('does not restore a list whose page the reader has left', () => {
    let scrollY = 4000;
    let now = 0;
    const frames: FrameRequestCallback[] = [];
    // The detail page on screen is far shorter than the list was.
    const maxScrollY = 1200;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
    vi.spyOn(window, 'scrollTo').mockImplementation((options) => {
      const top = (options as ScrollToOptions).top ?? 0;
      scrollY = Math.min(maxScrollY, Math.max(0, top));
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    let rememberGallery: ReturnType<typeof useDetailScrollRestore> = () => {};
    function Shell({
      galleryKey,
      galleryOnScreen,
      exploreKey
    }: {
      galleryKey: string | null;
      galleryOnScreen: boolean;
      exploreKey: string | null;
    }) {
      // Explore's hook first: the gallery's lives in the shell, whose layout
      // effects run after the page's, so its restore is the later one.
      useDetailScrollRestore(exploreKey);
      rememberGallery = useDetailScrollRestore(galleryKey, galleryOnScreen);
      return null;
    }

    root = createRoot(document.createElement('div'));
    act(() =>
      root?.render(
        <Shell galleryKey={null} galleryOnScreen exploreKey={null} />
      )
    );
    rememberGallery();
    act(() =>
      root?.render(<Shell galleryKey="file" galleryOnScreen exploreKey={null} />)
    );
    // A related post opens in explore: the gallery route, and with it the
    // gallery's open file, goes away in the same step.
    act(() =>
      root?.render(
        <Shell galleryKey={null} galleryOnScreen={false} exploreKey="post" />
      )
    );
    for (; now <= 4000; now += 16) {
      const pending = frames.splice(0);
      act(() => pending.forEach((frame) => frame(now)));
    }

    expect(scrollY).toBe(0);
  });
});

function Harness({ openKey }: { openKey: string }) {
  useDetailScrollRestore(openKey);
  return null;
}
