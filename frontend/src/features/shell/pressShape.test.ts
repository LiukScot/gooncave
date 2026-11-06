// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { MIN_PRESS_MS, listenForPresses } from './pressShape';

let stop: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML =
    '<button class="btn" id="round"><span id="icon"></span></button><button class="btn" id="off" disabled></button><button id="plain"></button>';
  stop = listenForPresses();
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

const fire = (id: string, type: string) =>
  document.getElementById(id)!.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { button: 0 }));

it('keeps a quick press squared off for the minimum time, then lets it go', () => {
  fire('icon', 'pointerdown');
  const round = document.getElementById('round')!;
  expect(round.hasAttribute('data-pressed')).toBe(true);
  vi.advanceTimersByTime(50);
  fire('icon', 'pointerup');
  vi.advanceTimersByTime(MIN_PRESS_MS - 60);
  expect(round.hasAttribute('data-pressed')).toBe(true);
  vi.advanceTimersByTime(10);
  expect(round.hasAttribute('data-pressed')).toBe(false);
});

it('leaves a long press as long as the finger stays', () => {
  fire('round', 'pointerdown');
  vi.advanceTimersByTime(MIN_PRESS_MS * 3);
  const round = document.getElementById('round')!;
  expect(round.hasAttribute('data-pressed')).toBe(true);
  fire('round', 'pointerup');
  vi.advanceTimersByTime(0);
  expect(round.hasAttribute('data-pressed')).toBe(false);
});

it('marks no disabled or unlisted button', () => {
  fire('off', 'pointerdown');
  fire('plain', 'pointerdown');
  expect(document.querySelector('[data-pressed]')).toBeNull();
});
