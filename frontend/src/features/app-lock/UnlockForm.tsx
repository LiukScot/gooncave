import { ScanFace } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { biometryName, lockApi, useAppLockStore } from './appLock';
import { CodePad } from './CodeSheet';

import { logDeveloper } from '@/lib/windowErrorLog';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Face ID and the code keypad, each shown when its lock is on, to unlock the app or to change a
 * lock. It fills a `CodeSheet`. Face ID is asked at once when `askAtOnce` is set; after five wrong codes each try waits a
 * minute.
 */
export function UnlockForm({
  submitLabel,
  askAtOnce = false,
  onUnlocked
}: {
  submitLabel: string;
  askAtOnce?: boolean;
  onUnlocked: () => void;
}) {
  const biometry = useAppLockStore((state) => state.biometry);
  const known = useAppLockStore((state) => state.known);
  // Until the iPhone answers, both are offered: an unknown lock must still let the person in.
  const codeLock = useAppLockStore((state) => state.code) || !known;
  const faceLock = useAppLockStore((state) => state.face);
  const name = faceLock || !known ? biometryName(biometry) ?? 'Face ID' : null;
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);
  const asked = useRef(false);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setWait((left) => left - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [wait]);

  const askBiometry = async () => {
    setError(null);
    try {
      const asked = performance.now();
      const answer = await lockApi.biometric();
      const answered = performance.now();
      if (answer.ok) {
        onUnlocked();
        // Two frames: the first after unlocking is drawn, the second shows it reached the screen.
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            logDeveloper(
              `${name ?? 'Face ID'} unlocked: it answered ${Math.round(answered - asked)} ms after asking, ` +
                `and the app was drawn ${Math.round(performance.now() - answered)} ms later.`
            )
          )
        );
      }
      else if (!answer.fallback) setError(`${name ?? 'Face ID'} did not unlock. Try again${codeLock ? ' or enter your code' : ''}.`);
    } catch (err) {
      setError(message(err));
    }
  };

  useEffect(() => {
    if (!askAtOnce || !faceLock) return;
    // Face ID only answers an app on screen; the lock is drawn while the app is away.
    const ask = () => {
      if (asked.current || document.visibilityState !== 'visible') return;
      // Once per showing: a failed Face ID leaves the code field for the person.
      asked.current = true;
      void askBiometry();
    };
    ask();
    document.addEventListener('visibilitychange', ask);
    return () => document.removeEventListener('visibilitychange', ask);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askAtOnce, faceLock]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await lockApi.check(code);
      setCode('');
      if (answer.ok) return onUnlocked();
      setWait(answer.wait);
      setError(answer.wait > 0 ? 'Too many wrong codes.' : 'Wrong code.');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const faceButton = name ? (
    <button
      type="button"
      className={codeLock ? 'app-lock-key is-quiet' : 'btn btn-primary app-lock-submit'}
      aria-label={`Unlock with ${name}`}
      onClick={() => void askBiometry()}
    >
      {codeLock ? <ScanFace aria-hidden="true" /> : `Unlock with ${name}`}
    </button>
  ) : null;

  return (
    <>
      <p className="app-lock-message" role={error ? 'alert' : undefined}>
        {error ?? (wait > 0 ? `Try again in ${wait} s.` : codeLock ? 'Enter your code.' : null)}
      </p>
      {codeLock ? (
        <CodePad
          value={code}
          onChange={setCode}
          onSubmit={() => void submit()}
          submitLabel={submitLabel}
          busy={busy || wait > 0}
          corner={faceButton}
        />
      ) : (
        faceButton
      )}
    </>
  );
}
