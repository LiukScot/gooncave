import { useState } from 'react';

import {
  conflictsWith,
  DEFAULT_SHORTCUTS,
  formatShortcut,
  isBindableEvent,
  SHORTCUT_ACTIONS,
  SHORTCUT_META,
  type ShortcutAction
} from '@/features/shortcuts/shortcuts';
import {
  useShortcuts,
  useUpdateShortcuts
} from '@/features/shortcuts/useShortcuts';

const CONTEXT_LABELS: Record<string, string> = {
  detail: 'Detail view',
  dialog: 'Dialogs'
};

export function ShortcutSettings() {
  const shortcuts = useShortcuts();
  const update = useUpdateShortcuts();
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);

  const error = (update.error as Error | null)?.message ?? null;

  const capture = (
    action: ShortcutAction,
    event: React.KeyboardEvent<HTMLButtonElement>
  ) => {
    // Escape leaves capture mode rather than being bound: a keyboard user
    // who opened the row by accident needs a way back out.
    if (event.key === 'Escape') {
      setCapturing(null);
      return;
    }
    if (!isBindableEvent(event)) return;
    event.preventDefault();
    setCapturing(null);
    update.mutate({ ...shortcuts, [action]: event.key });
  };

  const grouped = ['detail', 'dialog'] as const;

  return (
    <div className="col-12">
      {error ? (
        <div className="text-destructive text-sm mb-3">{error}</div>
      ) : null}

      <p className="text-muted-foreground text-xs mb-3">
        Click a key, then press the one you want. Ctrl, Alt and ⌘ stay with the
        browser, so bindings are single keys. Dialogs always keep their buttons,
        so a binding you regret can never lock you in.
      </p>

      {grouped.map((context) => (
        <div key={context} className="mb-4">
          <div className="mb-2 font-medium">{CONTEXT_LABELS[context]}</div>
          <div className="list-group">
            {SHORTCUT_ACTIONS.filter(
              (action) => SHORTCUT_META[action].context === context
            ).map((action) => {
              const clashes = conflictsWith(shortcuts, action);
              return (
                <div
                  key={action}
                  className="list-group-item flex items-center gap-3"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium">
                      {SHORTCUT_META[action].label}
                    </span>
                    {clashes.length > 0 ? (
                      <span className="block text-destructive text-xs">
                        Same key as{' '}
                        {clashes
                          .map((other) => SHORTCUT_META[other].label)
                          .join(', ')}
                      </span>
                    ) : null}
                  </span>
                  <button
                    className={`btn btn-sm ${
                      capturing === action ? 'btn-primary' : 'btn-outline-light'
                    }`}
                    type="button"
                    onClick={() => setCapturing(action)}
                    onBlur={() => setCapturing(null)}
                    onKeyDown={(event) => {
                      if (capturing !== action) return;
                      capture(action, event);
                    }}
                    aria-label={`Change the key for ${SHORTCUT_META[action].label}`}
                  >
                    {capturing === action
                      ? 'Press a key…'
                      : formatShortcut(shortcuts[action])}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <button
        className="btn btn-outline-light btn-sm"
        type="button"
        onClick={() => update.mutate({ ...DEFAULT_SHORTCUTS })}
        disabled={update.isPending}
      >
        Reset to defaults
      </button>
    </div>
  );
}
