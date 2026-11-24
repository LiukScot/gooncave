import { CheckCheck, MoreHorizontal, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

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
 * unless the action resolves to 'keep'. When the buttons do not fit on one row, as on a
 * phone, they move into a menu that opens above the bar.
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
  const [folded, setFolded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const row = useRef<HTMLDivElement>(null);

  // Measured before paint, so the row that does not fit never shows.
  useLayoutEffect(() => {
    const buttons = row.current;
    if (!folded && buttons && buttons.scrollWidth > buttons.clientWidth) setFolded(true);
  }, [folded, count, actions]);
  // A narrower window may no longer hold the row; a wider one may hold the folded row again,
  // so that one is laid out and measured once more.
  useEffect(() => {
    const refit = () => {
      const buttons = row.current;
      if (!buttons) setFolded(false);
      else if (buttons.scrollWidth > buttons.clientWidth) setFolded(true);
    };
    window.addEventListener('resize', refit);
    return () => window.removeEventListener('resize', refit);
  }, []);

  const start = async ({ key, run }: SelectionAction) => {
    setMenuOpen(false);
    setRunning(key);
    let outcome: unknown;
    try {
      outcome = await run();
    } finally {
      setRunning(null);
    }
    if (outcome !== 'keep') onCancel();
  };
  const selectAll: SelectionAction = {
    key: 'select-all',
    label: 'Select all',
    icon: CheckCheck,
    run: async () => {
      onSelectAll();
      return 'keep';
    }
  };

  return (
    <div className="selection-bar" role="toolbar" aria-label="Selection" data-test-id="selection-bar">
      <span className="selection-bar-count" aria-live="polite">
        {count} selected
      </span>
      {folded ? (
        <>
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="btn btn-outline-light selection-bar-button selection-bar-round"
                aria-label="Actions"
                title="Actions"
                aria-busy={running !== null}
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="end" sideOffset={12} aria-label="Actions for the selection" className="more-actions-menu">
              <div className="more-actions-pills">
                {[...actions, selectAll].map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    className={`btn btn-outline-light panel-pill${action.danger ? ' more-actions-danger' : ''}`}
                    disabled={running !== null}
                    onClick={() => void start(action)}
                  >
                    <action.icon aria-hidden="true" />
                    {action.label}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <button
            type="button"
            className="btn btn-outline-light selection-bar-button selection-bar-round"
            aria-label="Cancel"
            title="Cancel"
            onClick={onCancel}
            disabled={running !== null}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </>
      ) : (
        <div ref={row} className="selection-bar-actions">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              className={`btn ${action.danger ? 'btn-outline-danger' : 'btn-outline-light'} selection-bar-button`}
              disabled={running !== null}
              aria-busy={running === action.key}
              onClick={() => void start(action)}
            >
              <action.icon className="size-4" aria-hidden="true" />
              {action.label}
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
      )}
    </div>
  );
}
