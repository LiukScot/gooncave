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

interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  destructive?: boolean;
}

type ConfirmFn = (
  message: string,
  options?: ConfirmOptions
) => Promise<boolean>;

interface PendingConfirm extends Required<ConfirmOptions> {
  message: string;
  resolve: (answer: boolean) => void;
}

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

/**
 * Replaces `window.confirm`. The native dialog blocks the main thread, and
 * on iOS Safari the page stops responding to touch scrolling once it is
 * dismissed — tapping "delete" and backing out left the viewer stuck.
 */
export function ConfirmProvider({
  children
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [pending, setPending] = React.useState<PendingConfirm | null>(null);

  const confirm = React.useCallback<ConfirmFn>(
    (message, options) =>
      new Promise<boolean>((resolve) => {
        setPending({
          message,
          title: options?.title ?? 'Are you sure?',
          confirmLabel: options?.confirmLabel ?? 'Confirm',
          destructive: options?.destructive ?? false,
          resolve
        });
      }),
    []
  );

  const settle = (answer: boolean): void => {
    if (!pending) return;
    pending.resolve(answer);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{pending?.title}</DialogTitle>
            <DialogDescription>{pending?.message}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => settle(false)}>
              Cancel
            </Button>
            <Button
              variant={pending?.destructive ? 'destructive' : 'default'}
              onClick={() => settle(true)}
            >
              {pending?.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = React.useContext(ConfirmContext);
  if (!confirm) {
    throw new Error('useConfirm must be used inside <ConfirmProvider>');
  }
  return confirm;
}
