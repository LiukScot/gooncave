import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';

type ButtonVariant = React.ComponentProps<typeof Button>['variant'];

export interface ChoiceAction<T extends string> {
  value: T;
  label: string;
  variant?: ButtonVariant;
}

interface ChoiceOptions<T extends string> {
  title?: string;
  actions: ChoiceAction<T>[];
  cancelLabel?: string;
  /** Shown under the message, set apart: the values the action acts on. */
  details?: string;
}

/** Resolves to the chosen action, or null when the dialog is dismissed. */
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

  return (
    <ChoiceContext.Provider value={choose}>
      {children}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) settle(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{pending?.title}</DialogTitle>
            <DialogDescription>{pending?.message}</DialogDescription>
            {pending?.details ? (
              <div className="rounded-md bg-secondary px-3 py-2 text-sm font-semibold text-foreground">
                {pending.details}
              </div>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => settle(null)}>
              {pending?.cancelLabel}
            </Button>
            {pending?.actions.map((action) => (
              <Button
                key={action.value}
                variant={action.variant ?? 'default'}
                onClick={() => settle(action.value)}
              >
                {action.label}
              </Button>
            ))}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ChoiceContext.Provider>
  );
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
