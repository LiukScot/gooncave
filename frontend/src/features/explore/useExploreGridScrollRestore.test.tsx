// @vitest-environment happy-dom

import { act, StrictMode, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useExploreGridScrollRestore } from './useExploreGridScrollRestore';

import { restoreScrollTo } from '@/features/file-detail/restoreScrollTo';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('@/features/file-detail/restoreScrollTo', () => ({
  restoreScrollTo: vi.fn()
}));

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.clearAllMocks();
});

it('stops restoring the old Explore position when a detail opens', () => {
  const stop = vi.fn();
  vi.mocked(restoreScrollTo).mockReturnValue(stop);
  function Harness({ gridVisible }: { gridVisible: boolean }) {
    useExploreGridScrollRestore(740, gridVisible);
    return null;
  }

  root = createRoot(document.createElement('div'));
  act(() => root?.render(<Harness gridVisible />));
  expect(restoreScrollTo).toHaveBeenCalledWith(740);

  act(() => root?.render(<Harness gridVisible={false} />));
  expect(stop).toHaveBeenCalledOnce();
  expect(restoreScrollTo).toHaveBeenCalledTimes(1);
});

it('does not restore Explore under a pool detail', () => {
  root = createRoot(document.createElement('div'));
  function Harness() {
    useExploreGridScrollRestore(740, false);
    return null;
  }

  act(() => root?.render(<Harness />));
  expect(restoreScrollTo).not.toHaveBeenCalled();
});

it('stops the grid restore before the detail layout effect runs', () => {
  const stop = vi.fn();
  vi.mocked(restoreScrollTo).mockReturnValue(stop);
  const stoppedDuringDetailLayout: boolean[] = [];

  function Harness({ gridVisible }: { gridVisible: boolean }) {
    useExploreGridScrollRestore(740, gridVisible);
    useLayoutEffect(() => {
      if (!gridVisible) stoppedDuringDetailLayout.push(stop.mock.calls.length > 0);
    }, [gridVisible]);
    return null;
  }

  root = createRoot(document.createElement('div'));
  act(() => root?.render(<Harness gridVisible />));
  act(() => root?.render(<Harness gridVisible={false} />));

  expect(stoppedDuringDetailLayout).toEqual([true]);
});

it('does not restore the old grid offset after closing a detail', () => {
  vi.mocked(restoreScrollTo).mockReturnValue(vi.fn());
  function Harness({ gridVisible }: { gridVisible: boolean }) {
    useExploreGridScrollRestore(740, gridVisible);
    return null;
  }

  root = createRoot(document.createElement('div'));
  act(() => root?.render(<Harness gridVisible />));
  act(() => root?.render(<Harness gridVisible={false} />));
  act(() => root?.render(<Harness gridVisible />));

  expect(restoreScrollTo).toHaveBeenCalledTimes(1);
});

it('restarts restoration after the StrictMode effect replay', () => {
  const firstStop = vi.fn();
  const secondStop = vi.fn();
  vi.mocked(restoreScrollTo)
    .mockReturnValueOnce(firstStop)
    .mockReturnValueOnce(secondStop);
  function Harness() {
    useExploreGridScrollRestore(740, true);
    return null;
  }

  root = createRoot(document.createElement('div'));
  act(() => root?.render(<StrictMode><Harness /></StrictMode>));

  expect(firstStop).toHaveBeenCalledOnce();
  expect(restoreScrollTo).toHaveBeenCalledTimes(2);
  expect(secondStop).not.toHaveBeenCalled();
});
