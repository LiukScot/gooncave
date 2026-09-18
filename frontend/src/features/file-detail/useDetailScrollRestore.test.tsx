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
});

function Harness({ openKey }: { openKey: string }) {
  useDetailScrollRestore(openKey);
  return null;
}
