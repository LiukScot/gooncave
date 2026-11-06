import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** A control made for the corner, in the panel: its answer would appear behind the panel. */
export function ClosesPanel({ close, children }: { close: () => void; children: ReactNode }) {
  return (
    <div className="contents" onClick={close}>
      {children}
    </div>
  );
}

/** The less frequent actions on an open file or post: the corner button and the menu it opens above itself. */
export function MoreActionsPanel({
  open,
  setOpen,
  title,
  busy,
  children
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Names the panel for screen readers. */
  title: string;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="file-detail-overlay-btn file-detail-main-action file-detail-more-action"
          aria-label="More actions"
          title="More actions"
          aria-busy={busy}
        >
          <MoreHorizontal className="file-detail-overlay-icon" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={12} aria-label={title} className="more-actions-menu">
        <div className="more-actions-pills">{children}</div>
      </PopoverContent>
    </Popover>
  );
}
