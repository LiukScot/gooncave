// @vitest-environment happy-dom

import { act } from 'react';
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
