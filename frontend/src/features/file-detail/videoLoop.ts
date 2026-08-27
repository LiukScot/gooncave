/** How early the clip rewinds. `timeupdate` fires about four times a second,
 * so anything smaller is regularly missed and the clip reaches its end. */
const REWIND_MARGIN_SECONDS = 0.25;

/**
 * Rewinds a playing clip a hair before its end so playback never stops.
 * WebKit reveals the whole native player chrome the moment a video reaches
 * its end, so a loop driven from `ended` flashes the controls on every
 * repeat. Seeking back while the clip is still running keeps them hidden.
 *
 * Call it from `timeupdate`. The cost is the last quarter second of the clip,
 * which the loop never plays; tightening that would need a timer polling
 * faster than `timeupdate` fires. Clips shorter than twice the margin are
 * left to `restartVideoLoop`: there is no tick left to catch them in time.
 */
export const rewindVideoBeforeEnd = (video: HTMLVideoElement): void => {
  const { currentTime, duration, paused } = video;
  if (paused || !Number.isFinite(duration)) return;
  if (duration <= REWIND_MARGIN_SECONDS * 2) return;
  if (currentTime < duration - REWIND_MARGIN_SECONDS) return;
  video.currentTime = 0;
};

/**
 * Restarts a finished clip. Backstop for the clips `rewindVideoBeforeEnd`
 * cannot catch; it costs a controls flash, which is why it is not the
 * primary path. The player drives its own loop instead of setting the `loop`
 * attribute: WebKit stops honouring `loop` on some clips and leaves the
 * video parked on its last frame, and the `ended` event needed to notice
 * that never fires while `loop` is on.
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

/**
 * Play/pause from a keyboard shortcut, for the case the native space-bar
 * handling misses: the browser only toggles playback when the <video> holds
 * focus, and in the detail view it usually does not, so the key scrolls the
 * page instead.
 *
 * Returns whether it acted. A picture has no video to toggle, and the caller
 * uses that to leave the keystroke alone rather than swallowing it.
 */
export const togglePlayback = (video: HTMLVideoElement | null): boolean => {
  if (!video) return false;
  if (!video.paused) {
    video.pause();
    return true;
  }
  void video.play().catch((err: unknown) => {
    // Pausing again before the play settles rejects the promise it returned.
    // The element is already in the state that second press asked for.
    if (err instanceof DOMException && err.name === 'AbortError') return;
    console.error('video-playback: unexpected playback error', err);
  });
  return true;
};
