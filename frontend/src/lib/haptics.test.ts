// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { PRESS_CHANGE_MS, listenForHaptics } from './haptics';

const impact = vi.fn<() => Promise<void>>();
let stop: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  impact.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML =
    '<button id="go"><span id="icon"></span></button><button id="off" disabled></button><div id="text"></div><input id="box" type="checkbox" />';
  stop = listenForHaptics(impact);
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

const fire = (id: string, type: string) =>
  document.getElementById(id)!.dispatchEvent(new Event(type, { bubbles: true }));

it('taps once for a press on a button or inside it', () => {
  fire('icon', 'click');
  expect(impact).toHaveBeenCalledTimes(1);
});

it('does not tap for a disabled button or plain text', () => {
  fire('off', 'click');
  fire('text', 'click');
  expect(impact).not.toHaveBeenCalled();
});

it('taps once when a press also changes a value, and again for a later change', () => {
  fire('box', 'click');
  fire('box', 'change');
  expect(impact).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(PRESS_CHANGE_MS);
  fire('box', 'change');
  expect(impact).toHaveBeenCalledTimes(2);
});

it('stops calling once the app refuses a tap', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  impact.mockRejectedValue(new Error('unavailable'));
  fire('go', 'click');
  await vi.advanceTimersByTimeAsync(PRESS_CHANGE_MS);
  fire('go', 'click');
  expect(impact).toHaveBeenCalledTimes(1);
});

it('does not tap when a finger lands on a control only to scroll', () => {
  fire('go', 'pointerdown');
  expect(impact).not.toHaveBeenCalled();
});
