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

function Harness({ itemKey = 'file-1' }: { itemKey?: string }) {
  const overlay = useTouchOverlay(itemKey);
  return (
    <div data-active={String(overlay.active)} data-test="wrap" onPointerDownCapture={overlay.onPointerDownCapture} onPointerUpCapture={overlay.onPointerUpCapture} onPointerCancelCapture={overlay.onPointerCancelCapture} onPointerMoveCapture={overlay.onPointerActivity} onPointerLeave={overlay.onPointerActivity}>
      <button className="file-detail-overlay-btn">vote</button>
      <div className="video-controls"><input type="range" aria-label="Seek" /></div>
      <img alt="" />
    </div>
  );
};

const pointer = (container: HTMLElement, selector: string, type: string, x = 0, y = 0) =>
  act(() => {
    container.querySelector(selector)?.dispatchEvent(
      Object.assign(new Event(type, { bubbles: true }), {
        pointerType: 'touch', pointerId: 1, clientX: x, clientY: y
      })
    );
  });
const touch = (container: HTMLElement, selector: string) => {
  pointer(container, selector, 'pointerdown');
  pointer(container, selector, 'pointerup');
};
const active = (container: HTMLElement) => container.querySelector('[data-test]')?.getAttribute('data-active');

it('shows the buttons on a touch and hides them after a few seconds', () => {
  const container = mount();
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS + 1));
  touch(container, 'img');
  expect(active(container)).toBe('true');
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS + 1));
  expect(active(container)).toBe('false');
});

it('hides them at once when the picture is touched again, but not when a button is', () => {
  const container = mount();
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS + 1));
  touch(container, 'img');
  touch(container, '.file-detail-overlay-btn');
  expect(active(container)).toBe('true');
  touch(container, 'img');
  expect(active(container)).toBe('false');
});

it('does not toggle controls on a mouse press', () => {
  const container = mount();
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS + 1));
  act(() => {
    container.querySelector('img')?.dispatchEvent(
      Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: 'mouse' })
    );
  });
  expect(active(container)).toBe('false');
});

it('shows the controls for four seconds when a file opens', () => {
  const container = mount();
  expect(active(container)).toBe('true');
  act(() => void vi.advanceTimersByTime(3_999));
  expect(active(container)).toBe('true');
  act(() => void vi.advanceTimersByTime(1));
  expect(active(container)).toBe('false');
});

it('starts a fresh four seconds when navigating to another file', () => {
  const container = mount();
  touch(container, 'img');
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS - 1));
  act(() => root?.render(<Harness itemKey="file-2" />));
  expect(active(container)).toBe('true');
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS - 1));
  expect(active(container)).toBe('true');
  act(() => void vi.advanceTimersByTime(1));
  expect(active(container)).toBe('false');
});

it('keeps controls visible during a long seek and restarts the timer on release', () => {
  const container = mount();
  pointer(container, 'input', 'pointerdown');
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS * 2));
  expect(active(container)).toBe('true');
  pointer(container, 'input', 'pointerup');
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS - 1));
  expect(active(container)).toBe('true');
  act(() => void vi.advanceTimersByTime(1));
  expect(active(container)).toBe('false');
});

it('restarts the idle timer when a mouse moves across the detail view', () => {
  const container = mount();
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS + 1));
  const move = () => act(() => {
    container.querySelector('img')?.dispatchEvent(
      Object.assign(new Event('pointermove', { bubbles: true }), { pointerType: 'mouse' })
    );
  });
  move();
  expect(active(container)).toBe('true');
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS - 1));
  move();
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS - 1));
  expect(active(container)).toBe('true');
  act(() => void vi.advanceTimersByTime(1));
  expect(active(container)).toBe('false');
});

it('clears the mouse idle timer when the detail view closes', () => {
  const container = mount();
  act(() => {
    container.querySelector('img')?.dispatchEvent(
      Object.assign(new Event('pointermove', { bubbles: true }), { pointerType: 'mouse' })
    );
  });
  act(() => root?.unmount());
  root = null;
  expect(vi.getTimerCount()).toBe(0);
});

it.each([-60, 60])('does not toggle while dragging vertically by %s pixels', (distance) => {
  const container = mount();
  pointer(container, 'img', 'pointerdown');
  expect(active(container)).toBe('true');
  pointer(container, 'img', 'pointermove', 0, distance);
  pointer(container, 'img', 'pointermove');
  pointer(container, 'img', 'pointerup');
  expect(active(container)).toBe('true');
  touch(container, 'img');
  expect(active(container)).toBe('false');
  pointer(container, 'img', 'pointerdown');
  pointer(container, 'img', 'pointermove', 0, distance);
  pointer(container, 'img', 'pointerup', 0, distance);
  expect(active(container)).toBe('false');
});

it('does not toggle a cancelled gesture and still accepts the next tap', () => {
  const container = mount();
  pointer(container, 'img', 'pointerdown');
  pointer(container, 'img', 'pointercancel');
  pointer(container, 'img', 'pointerup');
  expect(active(container)).toBe('true');
  touch(container, 'img');
  expect(active(container)).toBe('false');
});
