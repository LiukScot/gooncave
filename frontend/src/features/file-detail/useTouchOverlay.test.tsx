// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DOUBLE_TAP_MS } from './useDoubleTapFullscreen';
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
    <div data-active={String(overlay.active)} data-dismissed={String(overlay.dismissed)} data-test="wrap" onPointerDownCapture={overlay.onPointerDownCapture} onPointerUpCapture={overlay.onPointerUpCapture} onPointerCancelCapture={overlay.onPointerCancelCapture} onPointerMoveCapture={overlay.onPointerActivity} onPointerLeave={overlay.onPointerActivity}>
      <button className="file-detail-overlay-btn">vote</button>
      <div className="video-controls"><input type="range" aria-label="Seek" /></div>
      <div className="file-detail-media-wrap">
        <img alt="" />
        <video />
        <button className="file-detail-overlay-btn video-controls-play">play</button>
      </div>
      <p className="tags">tags</p>
    </div>
  );
};

const pointer = (container: HTMLElement, selector: string, type: string, x = 0, y = 0, pointerType = 'touch') =>
  act(() => {
    container.querySelector(selector)?.dispatchEvent(
      Object.assign(new Event(type, { bubbles: true }), {
        pointerType, pointerId: 1, clientX: x, clientY: y
      })
    );
  });
const touch = (container: HTMLElement, selector: string) => {
  pointer(container, selector, 'pointerdown');
  pointer(container, selector, 'pointerup');
  // A tap on the picture waits to see that no second tap follows.
  act(() => void vi.advanceTimersByTime(DOUBLE_TAP_MS));
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

it('hides them when the picture is touched again, but not when a button is', () => {
  const container = mount();
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS + 1));
  touch(container, 'img');
  touch(container, '.file-detail-overlay-btn');
  expect(active(container)).toBe('true');
  touch(container, 'img');
  expect(active(container)).toBe('false');
});

const click = (container: HTMLElement, selector: string) => {
  pointer(container, selector, 'pointerdown', 0, 0, 'mouse');
  pointer(container, selector, 'pointerup', 0, 0, 'mouse');
};
const dismissed = (container: HTMLElement) => container.querySelector('[data-test]')?.getAttribute('data-dismissed');

it('a click on the picture hides the controls once no second click follows, and another shows them', () => {
  const container = mount();
  click(container, 'img');
  expect(active(container)).toBe('true');
  act(() => void vi.advanceTimersByTime(250));
  expect(active(container)).toBe('false');
  expect(dismissed(container)).toBe('true');
  click(container, 'img');
  act(() => void vi.advanceTimersByTime(250));
  expect(active(container)).toBe('true');
  expect(dismissed(container)).toBe('false');
});

it('leaves a double click, and a click outside the picture, alone', () => {
  const container = mount();
  click(container, 'img');
  click(container, 'img');
  act(() => void vi.advanceTimersByTime(250));
  expect(active(container)).toBe('true');
  click(container, '.tags');
  act(() => void vi.advanceTimersByTime(250));
  expect(active(container)).toBe('true');
});

it('a hide that runs out on its own is not a dismissal', () => {
  const container = mount();
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS + 1));
  expect(active(container)).toBe('false');
  expect(dismissed(container)).toBe('false');
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

it('leaves the controls as they were on a double tap, which skips or opens fullscreen', () => {
  const container = mount();
  act(() => void vi.advanceTimersByTime(OVERLAY_SHOW_MS + 1));
  pointer(container, 'img', 'pointerdown');
  pointer(container, 'img', 'pointerup');
  pointer(container, 'img', 'pointerdown');
  pointer(container, 'img', 'pointerup');
  act(() => void vi.advanceTimersByTime(DOUBLE_TAP_MS));
  expect(active(container)).toBe('false');
});

it('puts the controls away once Play starts a paused video, and shows them on Pause', () => {
  const container = mount();
  const video = container.querySelector('video')!;
  let paused = true;
  Object.defineProperty(video, 'paused', { get: () => paused });
  touch(container, '.video-controls-play');
  act(() => void vi.advanceTimersByTime(0));
  expect(active(container)).toBe('false');
  expect(dismissed(container)).toBe('false');
  paused = false;
  touch(container, '.video-controls-play');
  expect(active(container)).toBe('true');
});
