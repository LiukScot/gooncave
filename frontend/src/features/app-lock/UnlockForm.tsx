import { useEffect, useRef, useState } from 'react';

import { biometryName, CODE_PATTERN, lockApi, useAppLockStore } from './appLock';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Face ID and the code field, each shown when its lock is on, to unlock the app or to change a
 * lock. Face ID is asked at once when `askAtOnce` is set; after five wrong codes each try waits a
 * minute.
 */
export function UnlockForm({
  id,
  submitLabel,
  askAtOnce = false,
  onUnlocked
}: {
  id: string;
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
      const answer = await lockApi.biometric();
      if (answer.ok) onUnlocked();
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

  return (
    <form
      className="app-lock-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {name ? (
        <button className="btn btn-primary" type="button" onClick={() => void askBiometry()}>
          Unlock with {name}
        </button>
      ) : null}
      {codeLock ? (
        <>
          <label className="font-medium" htmlFor={id}>
            Your code
          </label>
          <input
            id={id}
            name="code"
            className="form-control app-lock-code"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            pattern={CODE_PATTERN}
            required
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
          <button className="btn btn-outline-light" type="submit" disabled={busy || wait > 0}>
            {wait > 0 ? `Try again in ${wait} s` : submitLabel}
          </button>
        </>
      ) : null}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
