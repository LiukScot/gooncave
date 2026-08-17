const volumeKey = 'imagesearch.videoVolume';
const mutedKey = 'imagesearch.videoMuted';

export type VideoSound = { volume: number; muted: boolean };

const fullVolume: VideoSound = { volume: 1, muted: false };

/**
 * `Number(null)` and `Number('')` are both 0, so an absent key would read as
 * "muted" rather than "never set". Reject those before parsing.
 */
export const parseVideoVolume = (raw: string | null): number => {
  if (raw === null || raw.trim() === '') return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return 1;
  return value;
};

/**
 * Volume and mute are stored together because they are one setting to the
 * person using the player: dragging the volume slider to the bottom sets
 * `muted`, not `volume: 0`, so persisting the level alone brings the sound
 * back on the next video.
 *
 * Both sides swallow storage failures. Reading `window.localStorage` throws
 * SecurityError when the browser is set to block site data, and `setItem`
 * throws QuotaExceededError when the origin is full — neither is worth
 * failing a video over, and the caller has no recovery to offer beyond
 * "the level is not remembered this time".
 */
export const readVideoSound = (): VideoSound => {
  if (typeof window === 'undefined') return fullVolume;
  try {
    return {
      volume: parseVideoVolume(window.localStorage.getItem(volumeKey)),
      muted: window.localStorage.getItem(mutedKey) === '1'
    };
  } catch {
    return fullVolume;
  }
};

/** Returns false when the sound could not be persisted. */
export const writeVideoSound = ({ volume, muted }: VideoSound): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(volumeKey, String(volume));
    window.localStorage.setItem(mutedKey, muted ? '1' : '0');
    return true;
  } catch {
    return false;
  }
};
