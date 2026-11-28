import { KeyRound, ScanFace } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { biometryName, CODE_MAX, CODE_MIN, lockApi, useAppLockStore } from './appLock';
import { CodePad, CodeSheet } from './CodeSheet';
import { UnlockForm } from './UnlockForm';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Failure({ error }: { error: string | null }) {
  return error ? (
    <p className="text-destructive text-sm" role="alert">
      {error}
    </p>
  ) : null;
}

/** One lock's row: a switch that opens what turning it on or off needs. */
function LockRow({
  id,
  icon: Icon,
  label,
  description,
  on,
  onToggle,
  error,
  children
}: {
  id: string;
  icon: LucideIcon;
  label: string;
  description: string;
  on: boolean;
  onToggle: () => void;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="list-group-item flex flex-col gap-2">
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
          checked={on}
          onChange={onToggle}
        />
      </div>
      {children}
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
    setEditing(false);
    try {
      if (!face) {
        const answer = await lockApi.biometric();
        if (!answer.ok) return setError(`${name} did not work, so it stays off.`);
      }
      await lockApi.setFace(!face);
      setLocks({ face: !face });
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  };
  // With no lock on there is nothing to unlock first.
  const toggle = () => (code || face ? setEditing(true) : void change());
  return (
    <LockRow
      id="extra-faceLock"
      icon={ScanFace}
      label={name}
      description={`Asks for ${name} when GoonCave opens or comes back.`}
      on={face}
      onToggle={toggle}
      error={error}
    >
      {editing ? (
        <CodeSheet title={face ? `Turn off ${name}` : `Turn on ${name}`} onCancel={close}>
          <UnlockForm submitLabel="Continue" onUnlocked={() => void change()} />
        </CodeSheet>
      ) : null}
    </LockRow>
  );
}

/** Choosing a code: once, then again, on the same keypad as the lock. */
function NewCode({ onDone, onCancel }: { onDone: (code: string) => Promise<void>; onCancel: () => void }) {
  const [first, setFirst] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = async () => {
    if (first === null) {
      setFirst(code);
      setCode('');
      return setError(null);
    }
    if (code !== first) {
      setFirst(null);
      setCode('');
      return setError('The codes did not match. Choose a new one.');
    }
    setBusy(true);
    try {
      await onDone(code);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  return (
    <CodeSheet title={first === null ? 'Choose a code' : 'Enter it again'} onCancel={onCancel}>
      <p className="app-lock-message" role={error ? 'alert' : undefined}>
        {error ?? (first === null ? `${CODE_MIN} to ${CODE_MAX} digits.` : 'The same code, to be sure.')}
      </p>
      <CodePad
        // A new pad per step, so the second starts empty for screen readers too.
        key={first === null ? 'first' : 'again'}
        value={code}
        onChange={setCode}
        onSubmit={() => void next()}
        submitLabel={first === null ? 'Next' : 'Turn on the code'}
        busy={busy}
      />
    </CodeSheet>
  );
}

function CodeLock() {
  const { code: enabled, face, biometry, setLocks } = useAppLockStore();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setEditing(false);
    setError(null);
  };

  const turnOn = async (code: string) => {
    // Changing the locks while Face ID is on needs Face ID first.
    if (face && !(await lockApi.biometric()).ok) {
      throw new Error(`${biometryName(biometry) ?? 'Face ID'} did not unlock.`);
    }
    await lockApi.set(code);
    setLocks({ code: true });
    close();
  };

  const turnOff = async () => {
    setEditing(false);
    try {
      await lockApi.clear();
      setLocks({ code: false });
      setError(null);
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
      onToggle={() => setEditing(true)}
      error={error}
    >
      {!editing ? null : enabled ? (
        <CodeSheet title="Turn off the code" onCancel={close}>
          <UnlockForm submitLabel="Turn off the code" onUnlocked={() => void turnOff()} />
        </CodeSheet>
      ) : (
        <NewCode onDone={turnOn} onCancel={close} />
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
