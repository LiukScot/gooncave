// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installFrameMeter, summarizeFrames } from './perfTest';

import { api } from '@/api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('summarizeFrames', () => {
  it('counts the frames that came late and the visible hitches', () => {
    // Five frames at 60 Hz, one dropped frame (33 ms) and one hitch (80 ms).
    const times = [0, 16, 32, 48, 64, 97, 113, 193];
    expect(summarizeFrames(times)).toEqual({
      frames: 7,
      durationMs: 193,
      medianMs: 16,
      worstMs: 80,
      late: 2,
      hitches: 1
    });
  });

  it('counts every frame of a steadily slow measure as late against the screen', () => {
    expect(summarizeFrames([0, 33, 66, 99], 16.7)?.late).toBe(3);
    expect(summarizeFrames([0, 33, 66, 99])?.late).toBe(0);
  });

  it('has nothing to say about a measure of fewer than two frames', () => {
    expect(summarizeFrames([0, 16])).toBeNull();
  });
});

describe('installFrameMeter', () => {
  it('hands back the browser transition and logs its frames once it finishes', async () => {
    window.localStorage.setItem('gooncave.perfTest.frameMeter', '1');
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    let finish = () => undefined as void;
    const transition = { finished: new Promise<void>((resolve) => (finish = resolve)) };
    const start = vi.fn(() => transition);
    const page = document as unknown as { startViewTransition: (options: unknown) => unknown };
    page.startViewTransition = start;
    const sent = vi.spyOn(api, 'reportWindowError').mockResolvedValue(undefined);

    installFrameMeter();
    const options = { update: () => undefined, types: ['detail-open'] };
    expect(page.startViewTransition(options)).toBe(transition);
    expect(start).toHaveBeenCalledWith(options);
    for (const time of [0, 16, 32, 80]) frames.shift()?.(time);
    expect(sent).not.toHaveBeenCalled();
    finish();
    await transition.finished;
    await Promise.resolve();

    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][0]).toContain(
      '[developer] Frames during the detail-open animation: 3 in 80 ms'
    );
    expect(sent.mock.calls[0][0]).toContain('1 late');
  });
});
