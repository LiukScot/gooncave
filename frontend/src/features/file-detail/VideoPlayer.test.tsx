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
