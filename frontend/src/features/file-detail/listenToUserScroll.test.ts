// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest';

import { listenToUserScroll } from './listenToUserScroll';

afterEach(() => {
  vi.restoreAllMocks();
});

it('does not replace a saved list position with a router scroll', () => {
  const record = vi.fn();
  const stop = listenToUserScroll(record);
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(0);

  window.dispatchEvent(new Event('scroll'));
  expect(record).not.toHaveBeenCalled();

  window.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0 }));
  window.dispatchEvent(new Event('scroll'));
  expect(record).not.toHaveBeenCalled();

  window.dispatchEvent(new Event('wheel'));
  window.dispatchEvent(new Event('scroll'));
  expect(record).toHaveBeenCalledWith(0);

  window.dispatchEvent(new Event('click'));
  window.dispatchEvent(new Event('scroll'));
  expect(record).toHaveBeenCalledOnce();

  window.dispatchEvent(new Event('wheel'));
  window.dispatchEvent(new Event('popstate'));
  window.dispatchEvent(new Event('scroll'));
  expect(record).toHaveBeenCalledOnce();

  stop();
  window.dispatchEvent(new Event('scroll'));
  expect(record).toHaveBeenCalledOnce();
});
