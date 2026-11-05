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

// The detail page's own double tap (fullscreen) sits on the picture's box around the player.
function doubleTapVideo(pointerType: string, at: number, time: number) {
  const page = vi.fn();
  act(() =>
    root?.render(
      <div onDoubleClick={page}>
        <VideoPlayer src="/fixture.mp4" playsInline />
      </div>
    )
  );
  const video = container.querySelector('video')!;
  vi.spyOn(video, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 200));
  Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
  video.currentTime = time;
  act(() => {
    video.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType }));
    video.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: at }));
  });
  return { video, page };
}

it.each([
  [30, 20],
  [270, 40]
])('a double tap at %s px skips to %s s and keeps the tap from the page', (at, time) => {
  const { video, page } = doubleTapVideo('touch', at, 30);
  expect(video.currentTime).toBe(time);
  expect(page).not.toHaveBeenCalled();
  expect(container.querySelector('.video-skip-hint')?.textContent).toBe(at < 150 ? '−10 s' : '+10 s');
});

it('leaves a double tap in the middle, or with a mouse, to the page', () => {
  for (const [pointerType, at] of [['touch', 150], ['mouse', 270]] as const) {
    const { video, page } = doubleTapVideo(pointerType, at, 30);
    expect(page).toHaveBeenCalledOnce();
    expect(video.currentTime).toBe(30);
  }
});
