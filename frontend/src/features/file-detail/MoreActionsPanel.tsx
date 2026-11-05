import { MoreHorizontal } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { BottomPanel } from '@/features/shell/SearchPanel';

/** A control made for the corner, in the panel: its answer would appear behind the panel. */
export function ClosesPanel({
  close,
  shrink,
  children
}: {
  close: () => void;
  /** See `fitOnOneRow`. */
  shrink?: number;
  children: ReactNode;
}) {
  return (
    <div className="contents" data-shrink={shrink} onClick={close}>
      {children}
    </div>
  );
}

/**
 * Keeps the actions on one row: while they overflow it, the action with the lowest
 * `data-shrink` left shows its icon alone, then the next. The class is set here rather than in
 * React because only the browser knows the widths, and every render measures again.
 */
function fitOnOneRow(row: HTMLElement) {
  const actions = [...row.querySelectorAll<HTMLElement>('[data-shrink]')].sort(
    (a, b) => Number(a.dataset.shrink) - Number(b.dataset.shrink)
  );
  actions.forEach((action) => action.classList.remove('is-icon'));
  for (const action of actions) {
    if (row.scrollWidth <= row.clientWidth) return;
    action.classList.add('is-icon');
  }
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
  const rowRef = useRef<HTMLDivElement>(null);
  const watchRow = useCallback((row: HTMLDivElement | null) => {
    rowRef.current = row;
    if (!row) return;
    const resized = new ResizeObserver(() => fitOnOneRow(row));
    resized.observe(row);
    return () => {
      resized.disconnect();
      rowRef.current = null;
    };
  }, []);
  // A label can change length, such as Keep on device turning into Downloading.
  useLayoutEffect(() => {
    if (rowRef.current) fitOnOneRow(rowRef.current);
  });
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
      <BottomPanel open={open} setOpen={setOpen} title={title} triggerRef={triggerRef}>
        <div ref={watchRow} className="panel-pills more-actions-pills">
          {children}
        </div>
      </BottomPanel>
    </>
  );
}
