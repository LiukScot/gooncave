const storageKey = 'imagesearch.videoVolume';

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

export const readVideoVolume = (): number =>
  typeof window === 'undefined'
    ? 1
    : parseVideoVolume(window.localStorage.getItem(storageKey));

export const writeVideoVolume = (volume: number): void => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey, String(volume));
};
