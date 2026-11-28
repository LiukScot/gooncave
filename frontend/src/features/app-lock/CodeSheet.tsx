import { Delete, Lock } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { CODE_MAX, CODE_MIN } from './appLock';

let openSheets = 0;

/**
 * The whole screen, over the app and its dialogs: the lock and every code entry use it, so
 * setting a code looks like unlocking with it. The app under it takes no focus or taps.
 */
export function CodeSheet({
  title,
  onCancel,
  children
}: {
  title: string;
  /** Absent on the lock screen, which only unlocking closes. */
  onCancel?: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const root = document.getElementById('root');
    openSheets += 1;
    if (root) root.inert = true;
    return () => {
      openSheets -= 1;
      if (root && openSheets === 0) root.inert = false;
    };
  }, []);

  return createPortal(
    <div className="app-lock" role="dialog" aria-modal="true" aria-labelledby="app-lock-title">
      {onCancel ? (
        <button type="button" className="app-lock-cancel" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
      <Lock className="app-lock-icon" aria-hidden="true" />
      <h1 id="app-lock-title" className="app-lock-title">
        {title}
      </h1>
      {children}
    </div>,
    document.body
  );
}

/**
 * Dots and a phone keypad for a code of 4 to 12 digits. A hardware keyboard types into it too.
 * `corner` takes the empty key left of 0, where Face ID sits.
 */
export function CodePad({
  value,
  onChange,
  onSubmit,
  submitLabel,
  busy = false,
  corner
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  busy?: boolean;
  corner?: ReactNode;
}) {
  const ready = value.length >= CODE_MIN && !busy;
  // Read by the keyboard listener, which is added once.
  const latest = useRef({ value, onChange, onSubmit, ready });
  latest.current = { value, onChange, onSubmit, ready };

  useEffect(() => {
    const type = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const { value, onChange, onSubmit, ready } = latest.current;
      if (/^\d$/.test(event.key)) {
        if (value.length < CODE_MAX) onChange(value + event.key);
      } else if (event.key === 'Backspace') {
        onChange(value.slice(0, -1));
      } else if (event.key === 'Enter') {
        if (ready) onSubmit();
      } else {
        return;
      }
      event.preventDefault();
    };
    document.addEventListener('keydown', type);
    return () => document.removeEventListener('keydown', type);
  }, []);

  const press = (digit: string) => {
    if (value.length < CODE_MAX) onChange(value + digit);
  };

  return (
    <div className="app-lock-pad">
      <div className="app-lock-dots" aria-hidden="true">
        {Array.from({ length: Math.max(CODE_MIN, value.length) }, (_, index) => (
          <span key={index} className={`app-lock-dot${index < value.length ? ' is-filled' : ''}`} />
        ))}
      </div>
      <p className="sr-only" aria-live="polite">
        {value.length} of {CODE_MIN} to {CODE_MAX} digits entered
      </p>
      <div className="app-lock-keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button key={digit} type="button" className="app-lock-key" onClick={() => press(digit)}>
            {digit}
          </button>
        ))}
        <span className="app-lock-corner">{corner}</span>
        <button type="button" className="app-lock-key" onClick={() => press('0')}>
          0
        </button>
        <button
          type="button"
          className="app-lock-key is-quiet"
          aria-label="Delete last digit"
          disabled={value.length === 0}
          onClick={() => onChange(value.slice(0, -1))}
        >
          <Delete aria-hidden="true" />
        </button>
      </div>
      <button type="button" className="btn btn-primary app-lock-submit" disabled={!ready} onClick={onSubmit}>
        {submitLabel}
      </button>
    </div>
  );
}
