// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest';

import { scrollSidewaysOnWheel } from './scrollSidewaysOnWheel';

let now = 0;
vi.spyOn(performance, 'now').mockImplementation(() => now);
const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  // Every test starts a new gesture.
  now += 10_000;
});

const row = (scrollLeft: number) => {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollWidth', { value: 500 });
  Object.defineProperty(element, 'clientWidth', { value: 200 });
  element.scrollLeft = scrollLeft;
  document.body.append(element);
  const cleanup = scrollSidewaysOnWheel(element);
  if (cleanup) cleanups.push(cleanup);
  return element;
};

const wheel = (element: HTMLElement, deltaY: number, init: WheelEventInit = {}) => {
  const event = new WheelEvent('wheel', { deltaY, cancelable: true, bubbles: true, ...init });
  // happy-dom's WheelEvent drops modifier keys from its init.
  Object.defineProperty(event, 'ctrlKey', { value: init.ctrlKey ?? false });
  element.dispatchEvent(event);
  return event.defaultPrevented;
};

it('moves the row and keeps the page still while the row has room', () => {
  const element = row(100);
  expect(wheel(element, 40)).toBe(true);
  expect(element.scrollLeft).toBe(140);
});

it('hands the wheel back to the page at either end', () => {
  expect(wheel(row(0), -40)).toBe(false);
  expect(wheel(row(300), 40)).toBe(false);
});

it('keeps scrolling the page when the row slides under a page scroll', () => {
  const page = document.createElement('main');
  document.body.append(page);
  const element = row(100);
  wheel(page, 40);
  now += 50;
  expect(wheel(element, 40)).toBe(false);
  expect(element.scrollLeft).toBe(100);
  // A pause ends the page scroll; the next wheel over the row moves the row.
  now += 1_000;
  expect(wheel(element, 40)).toBe(true);
  expect(element.scrollLeft).toBe(140);
});

it('pauses card snapping while the wheel moves the row', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const element = row(100);
    wheel(element, 8);
    // Snapping would pull each small step back to the same card.
    expect(element.style.scrollSnapType).toBe('none');
    vi.advanceTimersByTime(500);
    expect(element.style.scrollSnapType).toBe('');
  } finally {
    vi.useRealTimers();
  }
});

it('leaves zoom gestures to the page and scales line-based wheels', () => {
  const element = row(100);
  expect(wheel(element, 40, { ctrlKey: true })).toBe(false);
  expect(element.scrollLeft).toBe(100);
  expect(wheel(element, 3, { deltaMode: WheelEvent.DOM_DELTA_LINE })).toBe(true);
  expect(element.scrollLeft).toBe(148);
});
