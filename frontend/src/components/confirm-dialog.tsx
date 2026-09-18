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
  const [actionsFit, setActionsFit] = React.useState(false);
  const actionsRef = React.useRef<HTMLDivElement>(null);
  const shortcuts = useShortcuts();

  React.useLayoutEffect(() => {
    if (!pending || pending.actions.length < 3) return;
    const measure = () => {
      const footer = actionsRef.current;
      if (!footer) return;
      const dialog = footer.closest<HTMLElement>('[data-slot="dialog-content"]');
      if (!dialog) return;
      const buttons = Array.from(footer.querySelectorAll('button'));
      const gap = parseFloat(getComputedStyle(footer).columnGap) || 0;
      const requiredWidth = buttons.reduce((total, button) => {
        const range = document.createRange();
        range.selectNodeContents(button);
        const style = getComputedStyle(button);
        return (
          total +
          range.getBoundingClientRect().width +
          parseFloat(style.paddingLeft) +
          parseFloat(style.paddingRight) +
          parseFloat(style.borderLeftWidth) +
          parseFloat(style.borderRightWidth)
        );
      }, gap * (buttons.length - 1));
      const dialogStyle = getComputedStyle(dialog);
      const viewportMargin =
        2 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      const availableWidth =
        document.documentElement.clientWidth -
        viewportMargin -
        parseFloat(dialogStyle.paddingLeft) -
        parseFloat(dialogStyle.paddingRight) -
        parseFloat(dialogStyle.borderLeftWidth) -
        parseFloat(dialogStyle.borderRightWidth);
      setActionsFit(requiredWidth <= availableWidth);
    };

    measure();
    const frame = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
    };
  }, [pending]);

  const choose = React.useCallback<ChooseFn>(
    (message, options) =>
      new Promise((resolve) => {
        setActionsFit(false);
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
          className={
            pending && pending.actions.length >= 3
              ? 'sm:w-max sm:max-w-[calc(100%-2rem)]'
              : undefined
          }
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
            ref={actionsRef}
            className={
              pending && pending.actions.length >= 3
                ? actionsFit
                  ? 'flex min-w-0 flex-row justify-start gap-2'
                  : 'flex min-w-0 flex-col gap-2'
                : 'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end'
            }
          >
            <Button
              variant="outline"
              onClick={() => settle(null)}
              title={withShortcutHint(
                pending?.cancelLabel ?? 'Cancel',
                shortcuts.dialogCancel
              )}
            >
              {pending?.cancelLabel}
            </Button>
            {pending?.actions.map((action, index) => (
              <Button
                key={action.value}
                variant={action.variant ?? 'default'}
                onClick={() => settle(action.value)}
                title={
                  index === 0
                    ? withShortcutHint(action.label, shortcuts.dialogConfirm)
                    : action.label
                }
              >
                {action.label}
              </Button>
            ))}
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
