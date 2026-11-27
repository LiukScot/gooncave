import { KeyRound, ScanFace } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { biometryName, CODE_PATTERN, lockApi, useAppLockStore } from './appLock';
import { UnlockForm } from './UnlockForm';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Failure({ error }: { error: string | null }) {
  return error ? (
    <p className="text-destructive text-sm" role="alert">
      {error}
    </p>
  ) : null;
}

/** One lock's row: a switch that opens what turning it on or off needs underneath. */
function LockRow({
  id,
  icon: Icon,
  label,
  description,
  on,
  editing,
  onToggle,
  error,
  children
}: {
  id: string;
  icon: LucideIcon;
  label: string;
  description: string;
  on: boolean;
  editing: boolean;
  onToggle: () => void;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="list-group-item flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Icon className="size-5 text-muted-foreground shrink-0" aria-hidden="true" />
        <span className="flex-1 min-w-0">
          <label className="block font-medium" htmlFor={id}>
            {label}
          </label>
          <span className="block text-muted-foreground text-xs">{description}</span>
        </span>
        <input
          className="form-check-input shrink-0"
          type="checkbox"
          id={id}
          name={id}
          checked={on !== editing}
          aria-expanded={editing}
          onChange={onToggle}
        />
      </div>
      {editing ? children : null}
      <Failure error={error} />
    </div>
  );
}

/** Face ID alone unlocks: turning it on asks for it once, so it cannot shut the person out. */
function FaceLock({ name }: { name: string }) {
  const { code, face, setLocks } = useAppLockStore();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setEditing(false);
    setError(null);
  };
  const change = async () => {
    try {
      if (!face) {
        const answer = await lockApi.biometric();
        if (!answer.ok) return setError(`${name} did not work, so it stays off.`);
      }
      await lockApi.setFace(!face);
      setLocks({ face: !face });
      close();
    } catch (err) {
      setError(message(err));
    }
  };
  // With no lock on there is nothing to unlock first.
  const toggle = () => (editing ? close() : code || face ? setEditing(true) : void change());
  return (
    <LockRow
      id="extra-faceLock"
      icon={ScanFace}
      label={name}
      description={`Asks for ${name} when GoonCave opens or comes back.`}
      on={face}
      editing={editing}
      onToggle={toggle}
      error={error}
    >
      <UnlockForm id="face-lock-unlock" submitLabel="Continue" onUnlocked={() => void change()} />
    </LockRow>
  );
}

function CodeLock() {
  const { code: enabled, face, biometry, setLocks } = useAppLockStore();
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setEditing(false);
    setCode('');
    setRepeat('');
    setError(null);
  };

  const turnOn = async () => {
    if (code !== repeat) return setError('The two codes are different.');
    try {
      // Changing the locks while Face ID is on needs Face ID first.
      if (face && !(await lockApi.biometric()).ok) {
        return setError(`${biometryName(biometry) ?? 'Face ID'} did not unlock.`);
      }
      await lockApi.set(code);
      setLocks({ code: true });
      close();
    } catch (err) {
      setError(message(err));
    }
  };

  const turnOff = async () => {
    try {
      await lockApi.clear();
      setLocks({ code: false });
      close();
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <LockRow
      id="extra-appLock"
      icon={KeyRound}
      label="Code"
      description="Asks for your code when GoonCave opens or comes back."
      on={enabled}
      editing={editing}
      onToggle={() => (editing ? close() : setEditing(true))}
      error={error}
    >
      {enabled ? (
        <UnlockForm id="app-lock-off" submitLabel="Turn off the code" onUnlocked={() => void turnOff()} />
      ) : (
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
            Turn on the code
          </button>
        </form>
      )}
    </LockRow>
  );
}

/** Settings → Extra → Privacy, on the iPhone: Face ID and the code lock the app separately. */
export function AppLockSetting() {
  const biometry = useAppLockStore((state) => state.biometry);
  const face = useAppLockStore((state) => state.face);
  // A Face ID lock stays listed after Face ID goes away, so it can still be turned off.
  const name = biometryName(biometry) ?? (face ? 'Face ID' : null);
  return (
    <>
      {name ? <FaceLock name={name} /> : null}
      <CodeLock />
    </>
  );
}
