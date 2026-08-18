/**
 * Restarts a finished clip. The player drives its own loop instead of setting
 * the `loop` attribute: WebKit stops honouring `loop` on some clips and leaves
 * the video parked on its last frame, and the `ended` event needed to notice
 * that never fires while `loop` is on. Driving it from `ended` costs one frame
 * of gap and behaves the same in every browser.
 */
export const restartVideoLoop = (video: HTMLVideoElement): void => {
  video.currentTime = 0;
  void video.play().catch((err) => {
    // The autoplay policy can refuse a restart that is not tied to a fresh
    // tap. There is nothing to recover: the controls are visible and the
    // viewer can replay by hand.
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      return;
    }
    console.error('video-loop: unexpected playback error', err);
  });
};
