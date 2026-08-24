import { describe, expect, it, vi } from 'vitest';

import { restartVideoLoop, rewindVideoBeforeEnd } from './videoLoop';

/** Only the two members the helper touches. */
const fakeVideo = (play: () => Promise<void>) =>
  ({ currentTime: 12.5, play: vi.fn(play) }) as unknown as HTMLVideoElement & {
    play: ReturnType<typeof vi.fn>;
  };

describe('restartVideoLoop', () => {
  it('rewinds and replays', async () => {
    const video = fakeVideo(() => Promise.resolve());
    restartVideoLoop(video);
    expect(video.currentTime).toBe(0);
    expect(video.play).toHaveBeenCalledOnce();
  });

  it('swallows a refused replay instead of throwing at the caller', async () => {
    const video = fakeVideo(() =>
      Promise.reject(new DOMException('NotAllowedError'))
    );
    expect(() => restartVideoLoop(video)).not.toThrow();
    // Let the rejected promise settle: an unhandled rejection here would fail
    // the run.
    await Promise.resolve();
    expect(video.currentTime).toBe(0);
  });

  it('logs unexpected playback errors', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const unexpectedError = new Error('MediaError: MEDIA_ERR_DECODE');
    const video = fakeVideo(() => Promise.reject(unexpectedError));

    restartVideoLoop(video);

    // Let the rejected promise settle
    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'video-loop: unexpected playback error',
      unexpectedError
    );
    expect(video.currentTime).toBe(0);

    consoleErrorSpy.mockRestore();
  });
});

/** Only the four members the rewind helper reads. */
const playingVideo = (currentTime: number, duration: number, paused = false) =>
  ({ currentTime, duration, paused }) as unknown as HTMLVideoElement;

describe('rewindVideoBeforeEnd', () => {
  it('rewinds once the clip is inside the margin', () => {
    const video = playingVideo(9.8, 10);
    rewindVideoBeforeEnd(video);
    expect(video.currentTime).toBe(0);
  });

  it('leaves a clip that is still far from the end alone', () => {
    const video = playingVideo(4, 10);
    rewindVideoBeforeEnd(video);
    expect(video.currentTime).toBe(4);
  });

  it('leaves a paused clip alone so scrubbing to the end does not jump', () => {
    const video = playingVideo(9.9, 10, true);
    rewindVideoBeforeEnd(video);
    expect(video.currentTime).toBe(9.9);
  });

  it('leaves a clip of unknown duration to the ended fallback', () => {
    const video = playingVideo(30, Infinity);
    rewindVideoBeforeEnd(video);
    expect(video.currentTime).toBe(30);
  });

  it('leaves a clip shorter than two margins to the ended fallback', () => {
    // Rewinding here would fire on the very first tick and never let the
    // clip play.
    const video = playingVideo(0.1, 0.4);
    rewindVideoBeforeEnd(video);
    expect(video.currentTime).toBe(0.1);
  });
});
