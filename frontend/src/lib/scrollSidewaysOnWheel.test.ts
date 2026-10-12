// @vitest-environment happy-dom

import { expect, it } from 'vitest';

import { scrollSidewaysOnWheel } from './scrollSidewaysOnWheel';

const row = (scrollLeft: number) => {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollWidth', { value: 500 });
  Object.defineProperty(element, 'clientWidth', { value: 200 });
  element.scrollLeft = scrollLeft;
  scrollSidewaysOnWheel(element);
  return element;
};

const wheel = (element: HTMLElement, deltaY: number) => {
  const event = new WheelEvent('wheel', { deltaY, cancelable: true });
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
