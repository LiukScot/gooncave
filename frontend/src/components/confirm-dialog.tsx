import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import {
  actionForKey,
  isBindableEvent,
  withShortcutHint
} from '@/features/shortcuts/shortcuts';
import { useShortcuts } from '@/features/shortcuts/useShortcuts';

type ButtonVariant = React.ComponentProps<typeof Button>['variant'];

export interface ChoiceAction<T extends string> {
  value: T;
  label: string;
  variant?: ButtonVariant;
  /** In a menu, sits under a divider: apart from the actions above it. */
  separated?: boolean;
}

interface ChoiceOptions<T extends string> {
  title?: string;
  actions: ChoiceAction<T>[];
  cancelLabel?: string;
  /** Shown under the message, set apart: the values the action acts on. */
  details?: string;
}

/**
 * Resolves to the chosen action, or null when the dialog is dismissed. An
 * empty `message` is a dialog whose title says everything — the tag actions
 * are titled with the tag itself.
 */
type ChooseFn = <T extends string>(
  message: string,
  options: ChoiceOptions<T>
) => Promise<T | null>;

interface PendingChoice {
  title: string;
  message: string;
  details?: string;
  actions: ChoiceAction<string>[];
  cancelLabel: string;
  resolve: (answer: string | null) => void;
}

const ChoiceContext = React.createContext<ChooseFn | null>(null);
const DialogOpenContext = React.createContext(false);

/**
 * Replaces `window.confirm`. The native dialog blocks the main thread and
 * only offers two answers; the tag actions need three, and everything here
 * has to look like the rest of the app.
 */
export function ConfirmProvider({
  children
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [pending, setPending] = React.useState<PendingChoice | null>(null);
  const shortcuts = useShortcuts();
  // Three actions or more read as a menu: one per row, top to bottom, with
  // Cancel last and quiet. Fewer are a question, answered side by side.
  const isMenu = pending !== null && pending.actions.length >= 3;

  const choose = React.useCallback<ChooseFn>(
    (message, options) =>
      new Promise((resolve) => {
        setPending({
          message,
          details: options.details,
          title: options.title ?? 'Are you sure?',
          actions: options.actions as ChoiceAction<string>[],
          cancelLabel: options.cancelLabel ?? 'Cancel',
          resolve: resolve as (answer: string | null) => void
        });
      }),
    []
  );

  const settle = (answer: string | null): void => {
    if (!pending) return;
    pending.resolve(answer);
    setPending(null);
  };

  // Radix answers Escape on its own, but confirm and dismiss have to work
  // wherever the focus happens to be — Enter would otherwise only fire the
  // button the focus ring is on, which is Cancel as often as not. Capture
  // phase so the binding wins over whatever has focus.
  React.useEffect(() => {
    if (!pending) return;
    const handler = (event: KeyboardEvent) => {
      if (!isBindableEvent(event)) return;
      const action = actionForKey(shortcuts, 'dialog', event.key);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'dialogConfirm') {
        // The first action is the affirmative one; Cancel is separate.
        const primary = pending.actions[0];
        if (primary) settle(primary.value);
      } else {
        settle(null);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
    // `settle` only reads `pending` and `setPending`, both covered here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, shortcuts]);

  return (
    <ChoiceContext.Provider value={choose}>
      <DialogOpenContext.Provider value={pending !== null}>
        {children}
      </DialogOpenContext.Provider>
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) settle(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className={isMenu ? 'sm:max-w-xs' : undefined}
        >
          <DialogHeader>
            <DialogTitle>{pending?.title}</DialogTitle>
            {pending?.message ? (
              <DialogDescription>{pending.message}</DialogDescription>
            ) : null}
            {pending?.details ? (
              <div className="rounded-md bg-secondary px-3 py-2 text-sm font-semibold text-foreground">
                {pending.details}
              </div>
            ) : null}
          </DialogHeader>
          <div
            className={
              isMenu
                ? 'confirm-menu flex min-w-0 flex-col'
                : 'flex flex-col gap-2 sm:flex-row-reverse sm:justify-start'
            }
          >
            {pending?.actions.map((action, index) => (
              <React.Fragment key={action.value}>
                {isMenu && action.separated ? (
                  <hr className="my-1 border-border" />
                ) : null}
                <Button
                  variant={action.variant ?? 'default'}
                  className={
                    isMenu && !action.separated
                      ? `confirm-menu-item${action.variant === 'destructive' ? ' is-destructive' : ''}`
                      : undefined
                  }
                  onClick={() => settle(action.value)}
                  title={
                    index === 0
                      ? withShortcutHint(action.label, shortcuts.dialogConfirm)
                      : action.label
                  }
                >
                  {action.label}
                </Button>
              </React.Fragment>
            ))}
            <Button
              variant={isMenu ? 'ghost' : 'outline'}
              size={isMenu ? 'sm' : 'default'}
              // The ghost hover puts dark ink on a half-strength fill, which
              // is hard to read here; a faint fill under light ink is not.
              className={
                isMenu
                  ? 'hover:bg-destructive/20 hover:text-destructive dark:hover:bg-destructive/20'
                  : undefined
              }
              onClick={() => settle(null)}
              title={withShortcutHint(
                pending?.cancelLabel ?? 'Cancel',
                shortcuts.dialogCancel
              )}
            >
              {pending?.cancelLabel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </ChoiceContext.Provider>
  );
}

/**
 * Whether a dialog is up. Global key handlers read it so a shortcut cannot
 * fire behind the dialog that is holding the user's attention.
 */
export function useDialogOpen(): boolean {
  return React.useContext(DialogOpenContext);
}

export function useChoose(): ChooseFn {
  const choose = React.useContext(ChoiceContext);
  if (!choose) {
    throw new Error('useChoose must be used inside <ConfirmProvider>');
  }
  return choose;
}

interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  destructive?: boolean;
  details?: string;
}

/** The yes/no case, which is most of them. */
export function useConfirm(): (
  message: string,
  options?: ConfirmOptions
) => Promise<boolean> {
  const choose = useChoose();
  return React.useCallback(
    async (message, options) => {
      const answer = await choose(message, {
        title: options?.title,
        details: options?.details,
        actions: [
          {
            value: 'confirm' as const,
            label: options?.confirmLabel ?? 'Confirm',
            variant: options?.destructive ? 'destructive' : 'default'
          }
        ]
      });
      return answer === 'confirm';
    },
    [choose]
  );
}
