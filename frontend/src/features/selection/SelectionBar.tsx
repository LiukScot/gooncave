import { CheckCheck, X } from 'lucide-react';
import { useState } from 'react';

export type SelectionAction = {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
  /** Drawn in the danger colour; `run` asks before it deletes anything. */
  danger?: boolean;
  /** Resolves to 'keep' to leave the selection as it is (e.g. the person cancelled a confirmation). */
  run: () => Promise<'keep' | unknown>;
};

/**
 * The bar shown while tiles are selected: how many, the actions that apply to all of them,
 * Select all loaded and Cancel. An action runs once at a time; the selection ends with it
 * unless the action resolves to 'keep'.
 */
export function SelectionBar({
  count,
  actions,
  onSelectAll,
  onCancel
}: {
  count: number;
  actions: SelectionAction[];
  onSelectAll: () => void;
  onCancel: () => void;
}) {
  const [running, setRunning] = useState<string | null>(null);
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selection" data-test-id="selection-bar">
      <span className="selection-bar-count" aria-live="polite">
        {count} selected
      </span>
      <div className="selection-bar-actions">
        {actions.map(({ key, label, icon: Icon, danger, run }) => (
          <button
            key={key}
            type="button"
            className={`btn ${danger ? 'btn-outline-danger' : 'btn-outline-light'} selection-bar-button`}
            disabled={running !== null}
            aria-busy={running === key}
            onClick={async () => {
              setRunning(key);
              let outcome: unknown;
              try {
                outcome = await run();
              } finally {
                setRunning(null);
              }
              if (outcome !== 'keep') onCancel();
            }}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </button>
        ))}
        <button type="button" className="btn btn-outline-light selection-bar-button" onClick={onSelectAll} disabled={running !== null}>
          <CheckCheck className="size-4" aria-hidden="true" />
          Select all
        </button>
        <button type="button" className="btn btn-outline-light selection-bar-button" onClick={onCancel} disabled={running !== null}>
          <X className="size-4" aria-hidden="true" />
          Cancel
        </button>
      </div>
    </div>
  );
}
