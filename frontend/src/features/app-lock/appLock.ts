import { invoke, isTauri } from '@tauri-apps/api/core';
import { z } from 'zod';
import { create } from 'zustand';

import { isIos } from '@/lib/platform';
import { logDeveloper } from '@/lib/windowErrorLog';

export type Biometry = 'faceID' | 'touchID' | 'none';

const stateSchema = z.object({
  code: z.boolean(),
  face: z.boolean(),
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
  /** Turning Face ID on needs a Face ID that just worked: call `biometric` first. */
  setFace: async (on: boolean) => {
    await call(on ? 'faceOn' : 'faceOff');
  },
  biometric: async () => biometricSchema.parse(await call('biometric'))
};

const hinted = (): boolean => lockAvailable() && localStorage.getItem(HINT_KEY) === '1';

type Locks = { code: boolean; face: boolean };

/** Face ID and the code lock the app separately; either one on locks it. */
export const useAppLockStore = create<
  Locks & {
    enabled: boolean;
    /** False until the iPhone says which locks are on; the lock screen then offers both. */
    known: boolean;
    locked: boolean;
    biometry: Biometry;
    setLocks: (locks: Partial<Locks>) => void;
    setBiometry: (biometry: Biometry) => void;
    setLocked: (locked: boolean) => void;
  }
>((set, get) => ({
  // Until the iPhone answers, the hint locks the first frame; which lock is on is not known yet.
  code: false,
  face: false,
  enabled: hinted(),
  known: false,
  locked: hinted(),
  biometry: 'none',
  setLocks: (locks) => {
    const next = { code: locks.code ?? get().code, face: locks.face ?? get().face };
    const enabled = next.code || next.face;
    if (enabled) localStorage.setItem(HINT_KEY, '1');
    else localStorage.removeItem(HINT_KEY);
    set(enabled ? { ...next, enabled, known: true } : { ...next, enabled, known: true, locked: false });
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
      store.setLocks({ code: state.code, face: state.face });
      if (state.code || state.face) store.setLocked(true);
    })
    .catch((error: unknown) => {
      // Locked stays as the hint left it: an unreadable lock must not open the app.
      logDeveloper(`The app lock did not answer at launch: ${error instanceof Error ? error.message : String(error)}`);
    });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && useAppLockStore.getState().enabled) {
      useAppLockStore.getState().setLocked(true);
    }
  });
};
