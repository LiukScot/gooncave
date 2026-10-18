// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { PopularPeriodNote } from './PopularPeriodNote';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

it('names the period and offers all time and newest', () => {
  const onAllTime = vi.fn();
  const onNewest = vi.fn();
  const container = document.createElement('div');
  root = createRoot(container);
  act(() =>
    root?.render(
      <PopularPeriodNote
        window="month"
        date="2026-10-16"
        onAllTime={onAllTime}
        onNewest={onNewest}
      />
    )
  );

  expect(container.textContent).toContain('October 2026');
  const buttons = [...container.querySelectorAll('button')];
  act(() => buttons.find((b) => b.textContent === 'Show all time')?.click());
  act(() => buttons.find((b) => b.textContent === 'Show newest')?.click());
  expect(onAllTime).toHaveBeenCalledOnce();
  expect(onNewest).toHaveBeenCalledOnce();
});
