import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';

const subscribe = (onChange: () => void) => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
};

// shortcut: this reads the network link, so Wi-Fi with no internet counts as online; probe a site if that matters.
export const isOnline = () => navigator.onLine;

/** Whether this device has a network. The library itself is on the device and works without one. */
export const useOnline = () => useSyncExternalStore(subscribe, isOnline);

/** For a tile whose original is out of reach. */
export const explainOfflineFile = () =>
  toast('This file is not on this device. It opens when you reconnect.', { id: 'offline-file' });
