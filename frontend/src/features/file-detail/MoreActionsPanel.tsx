import { MoreHorizontal } from 'lucide-react';
import { useRef } from 'react';
import type { ReactNode } from 'react';

import { BottomPanel } from '@/features/shell/SearchPanel';

/** A control made for the corner, in the panel: its answer would appear behind the panel. */
export function ClosesPanel({ close, children }: { close: () => void; children: ReactNode }) {
  return (
    <div className="contents" onClick={close}>
      {children}
    </div>
  );
}

/** The less frequent actions on an open file or post: the corner button and the panel it opens. */
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="file-detail-overlay-btn file-detail-main-action file-detail-more-action"
        aria-label="More actions"
        aria-haspopup="dialog"
        title="More actions"
        aria-busy={busy}
        onClick={() => setOpen(true)}
      >
        <MoreHorizontal className="file-detail-overlay-icon" aria-hidden="true" />
      </button>
      <BottomPanel open={open} setOpen={setOpen} title={title} triggerRef={triggerRef} head={<h2>Actions</h2>}>
        <div className="panel-pills more-actions-pills">{children}</div>
      </BottomPanel>
    </>
  );
}
