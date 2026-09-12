/** The two grids that carry the toggle; each remembers its own last state. */
export type UnreadView = 'gallery' | 'explore';

const storageKey = (view: UnreadView) => `imagesearch.unreadOnly.${view}`;

/**
 * Whether the Unread only filter was left on for this grid.
 *
 * Storage failures are swallowed on both sides: reading `window.localStorage`
 * throws SecurityError when the browser blocks site data, and `setItem` throws
 * QuotaExceededError when the origin is full. Neither is worth failing the
 * grid over — the filter just starts off and is not remembered this time.
 */
export const readUnreadOnly = (view: UnreadView): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(storageKey(view)) === '1';
  } catch {
    return false;
  }
};

/** Returns false when the state could not be persisted. */
export const writeUnreadOnly = (view: UnreadView, enabled: boolean): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(storageKey(view), enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
};
