import { Lock } from 'lucide-react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';

import { useAppLockStore } from './appLock';
import { UnlockForm } from './UnlockForm';

/** Covers the whole app while it is locked; the page under it takes no focus or taps. */
export function AppLockScreen() {
  const locked = useAppLockStore((state) => state.locked);
  const setLocked = useAppLockStore((state) => state.setLocked);

  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;
    root.inert = locked;
    return () => {
      root.inert = false;
    };
  }, [locked]);

  if (!locked) return null;
  return createPortal(
    <div className="app-lock" role="dialog" aria-modal="true" aria-labelledby="app-lock-title">
      <Lock className="app-lock-icon" aria-hidden="true" />
      <h1 id="app-lock-title" className="app-lock-title">
        GoonCave is locked
      </h1>
      <UnlockForm id="app-lock-code" submitLabel="Unlock" askAtOnce onUnlocked={() => setLocked(false)} />
    </div>,
    document.body
  );
}
