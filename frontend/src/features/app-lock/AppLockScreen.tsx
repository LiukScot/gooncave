import { useAppLockStore } from './appLock';
import { CodeSheet } from './CodeSheet';
import { UnlockForm } from './UnlockForm';

/** Covers the whole app while it is locked. */
export function AppLockScreen() {
  const locked = useAppLockStore((state) => state.locked);
  const setLocked = useAppLockStore((state) => state.setLocked);
  if (!locked) return null;
  return (
    <CodeSheet title="GoonCave is locked">
      <UnlockForm submitLabel="Unlock" askAtOnce onUnlocked={() => setLocked(false)} />
    </CodeSheet>
  );
}
