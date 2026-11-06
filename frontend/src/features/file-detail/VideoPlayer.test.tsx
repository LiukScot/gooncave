// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { VideoPlayer } from './VideoPlayer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<VideoPlayer src="/fixture.mp4" playsInline />));
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function clickVideo(pointerType: string, detail: number) {
  const video = container.querySelector('video')!;
  act(() => {
    video.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType }));
    video.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
    vi.advanceTimersByTime(300);
  });
}

it.each([0, 1])('leaves playback unchanged for a touch click with count %s', (detail) => {
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  clickVideo('touch', detail);
  expect(play).not.toHaveBeenCalled();
  expect(pause).not.toHaveBeenCalled();
});

it('still starts playback when the video is clicked with a mouse', () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  clickVideo('mouse', 1);
  expect(play).toHaveBeenCalledOnce();
});

function touchAt(video: HTMLVideoElement, type: 'touchstart' | 'touchend', x: number) {
  const touch = { clientX: x, clientY: 100 };
  const event = new Event(type, { bubbles: true });
  Object.assign(event, {
    touches: type === 'touchstart' ? [touch] : [],
    changedTouches: [touch]
  });
  video.dispatchEvent(event);
}

// iOS sends no dblclick for two quick taps, so the player reads the touches.
function doubleTapVideo(at: number, time: number) {
  const video = container.querySelector('video')!;
  vi.spyOn(video, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
  Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
  video.currentTime = time;
  act(() => {
    for (let tap = 0; tap < 2; tap += 1) {
      touchAt(video, 'touchstart', at);
      touchAt(video, 'touchend', at);
    }
  });
  return video;
}

it.each([
  [30, 20],
  [270, 40]
])('a double tap at %s px skips to %s s', (at, time) => {
  const video = doubleTapVideo(at, 30);
  expect(video.currentTime).toBe(time);
  expect(container.querySelector('.video-skip-hint')?.textContent).toBe(at < 150 ? '−10 s' : '+10 s');
});

it('leaves a double tap in the middle to the page', () => {
  const video = doubleTapVideo(150, 30);
  expect(video.currentTime).toBe(30);
  expect(container.querySelector('.video-skip-hint')).toBeNull();
});
