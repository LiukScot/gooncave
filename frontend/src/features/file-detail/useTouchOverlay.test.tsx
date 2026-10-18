// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { OVERLAY_SHOW_MS, useTouchOverlay } from './useTouchOverlay';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

const mount = () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
  return container;
};

function Harness() {
  const overlay = useTouchOverlay('file-1');
  return (
    <div data-active={String(overlay.active)} data-test="wrap" onPointerDownCapture={overlay.onPointerDownCapture}>
      <button className="file-detail-overlay-btn">vote</button>
      <img alt="" />
    </div>
  );
};

const touch = (container: HTMLElement, selector: string) =>
  act(() => {
    container.querySelector(selector)?.dispatchEvent(
      Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: 'touch' })
    );
  });
const active = (container: HTMLElement) => container.querySelector('[data-test]')?.getAttribute('data-active');

it('shows the buttons on a touch and hides them after a few seconds', () => {
  const container = mount();
  touch(container, 'img');
  expect(active(container)).toBe('true');
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS + 1));
  expect(active(container)).toBe('false');
});

it('hides them at once when the picture is touched again, but not when a button is', () => {
  const container = mount();
  touch(container, 'img');
  touch(container, '.file-detail-overlay-btn');
  expect(active(container)).toBe('true');
  touch(container, 'img');
  expect(active(container)).toBe('false');
});

it('ignores a mouse', () => {
  const container = mount();
  act(() => {
    container.querySelector('img')?.dispatchEvent(
      Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: 'mouse' })
    );
  });
  expect(active(container)).toBe('false');
});
