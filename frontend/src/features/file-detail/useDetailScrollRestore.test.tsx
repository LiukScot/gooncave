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
});
