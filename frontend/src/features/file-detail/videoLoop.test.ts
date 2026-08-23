import { describe, expect, it, vi } from 'vitest';

import { restartVideoLoop } from './videoLoop';

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
