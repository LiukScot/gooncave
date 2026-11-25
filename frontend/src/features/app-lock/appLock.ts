import { invoke, isTauri } from '@tauri-apps/api/core';
import { z } from 'zod';
import { create } from 'zustand';

import { isIos } from '@/lib/platform';

export type Biometry = 'faceID' | 'touchID' | 'none';

const stateSchema = z.object({
  enabled: z.boolean(),
  biometry: z.enum(['faceID', 'touchID', 'none']),
  wait: z.number().int().min(0)
});
const checkSchema = z.object({ ok: z.boolean(), wait: z.number().int().min(0) });
const biometricSchema = z.object({ ok: z.boolean(), fallback: z.boolean().optional() });

/** Lets the first frame at launch be locked already, before the iPhone answers. */
const HINT_KEY = 'gooncave.appLock';
export const CODE_PATTERN = '[0-9]{4,12}';

/** Only the iPhone app keeps a code and has Face ID. */
export const lockAvailable = (): boolean => isTauri() && isIos();

const call = (action: string, code?: string) => invoke<unknown>('app_lock', { action, code });

export const lockApi = {
  state: async () => stateSchema.parse(await call('state')),
  set: async (code: string) => {
    await call('set', code);
  },
  check: async (code: string) => checkSchema.parse(await call('check', code)),
  clear: async () => {
    await call('clear');
  },
  biometric: async () => biometricSchema.parse(await call('biometric'))
};

const hinted = (): boolean => lockAvailable() && localStorage.getItem(HINT_KEY) === '1';

export const useAppLockStore = create<{
  enabled: boolean;
  locked: boolean;
  biometry: Biometry;
  setEnabled: (enabled: boolean) => void;
  setBiometry: (biometry: Biometry) => void;
  setLocked: (locked: boolean) => void;
}>((set) => ({
  enabled: hinted(),
  locked: hinted(),
  biometry: 'none',
  setEnabled: (enabled) => {
    if (enabled) localStorage.setItem(HINT_KEY, '1');
    else localStorage.removeItem(HINT_KEY);
    set(enabled ? { enabled } : { enabled, locked: false });
  },
  setBiometry: (biometry) => set({ biometry }),
  setLocked: (locked) => set({ locked })
}));

export const biometryName = (biometry: Biometry): string | null =>
  biometry === 'faceID' ? 'Face ID' : biometry === 'touchID' ? 'Touch ID' : null;

/** Locks at launch and at every return from the background while the lock is on. */
export const installAppLock = () => {
  if (!lockAvailable()) return;
  const store = useAppLockStore.getState();
  lockApi
    .state()
    .then((state) => {
      store.setBiometry(state.biometry);
      if (state.enabled !== useAppLockStore.getState().enabled) store.setEnabled(state.enabled);
      if (state.enabled) store.setLocked(true);
    })
    .catch((error: unknown) => {
      // Locked stays as the hint left it: an unreadable lock must not open the app.
      console.error('[developer] The app lock did not answer at launch', error);
    });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && useAppLockStore.getState().enabled) {
      useAppLockStore.getState().setLocked(true);
    }
  });
};
