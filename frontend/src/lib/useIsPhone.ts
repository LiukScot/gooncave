import { useSyncExternalStore } from 'react';

// The width at which the app switches to its one-column phone layout (see the app.css breakpoints).
const PHONE_QUERY = '(max-width: 767.98px)';

const subscribe = (onChange: () => void) => {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/** Whether the window is phone-sized; follows rotation and resizing. */
export const useIsPhone = (): boolean =>
  useSyncExternalStore(subscribe, () => window.matchMedia(PHONE_QUERY).matches, () => false);
