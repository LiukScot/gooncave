import { KeyRound, ScanFace } from 'lucide-react';
import { useState } from 'react';

import { biometryName, CODE_PATTERN, lockApi, useAppLockStore } from './appLock';
import { UnlockForm } from './UnlockForm';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Settings → Extra → Privacy, on the iPhone: turns the app lock on with a new code, or off after unlocking. */
export function AppLockSetting() {
  const enabled = useAppLockStore((state) => state.enabled);
  const biometry = useAppLockStore((state) => state.biometry);
  const setEnabled = useAppLockStore((state) => state.setEnabled);
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const name = biometryName(biometry);
  const Icon = name ? ScanFace : KeyRound;

  const close = () => {
    setEditing(false);
    setCode('');
    setRepeat('');
    setError(null);
  };

  const turnOn = async () => {
    if (code !== repeat) return setError('The two codes are different.');
    try {
      await lockApi.set(code);
      setEnabled(true);
      close();
    } catch (err) {
      setError(message(err));
    }
  };

  const turnOff = async () => {
    try {
      await lockApi.clear();
      setEnabled(false);
      close();
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <div className="list-group-item flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Icon className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
        <span className="flex-1 min-w-0">
          <label className="block font-medium" htmlFor="extra-appLock">
            {name ? `${name} lock` : 'Code lock'}
          </label>
          <span className="block text-muted-foreground text-xs">
            Asks for {name ? `${name} or ` : ''}your code when GoonCave opens or comes back.
          </span>
        </span>
        <input
          className="form-check-input shrink-0"
          type="checkbox"
          id="extra-appLock"
          name="extra-appLock"
          checked={enabled !== editing}
          aria-expanded={editing}
          onChange={() => (editing ? close() : setEditing(true))}
        />
      </div>
      {editing && !enabled ? (
        <form
          className="app-lock-form"
          onSubmit={(event) => {
            event.preventDefault();
            void turnOn();
          }}
        >
          <label className="font-medium" htmlFor="app-lock-new">
            New code, 4 to 12 digits
          </label>
          <input
            id="app-lock-new"
            name="new-code"
            className="form-control app-lock-code"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            pattern={CODE_PATTERN}
            required
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
          <label className="font-medium" htmlFor="app-lock-repeat">
            The same code again
          </label>
          <input
            id="app-lock-repeat"
            name="repeat-code"
            className="form-control app-lock-code"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            pattern={CODE_PATTERN}
            required
            value={repeat}
            onChange={(event) => setRepeat(event.target.value.replace(/\D/g, ''))}
          />
          <button className="btn btn-primary" type="submit">
            Turn on the lock
          </button>
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
      {editing && enabled ? (
        <>
          <UnlockForm id="app-lock-off" submitLabel="Turn off the lock" onUnlocked={() => void turnOff()} />
          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
