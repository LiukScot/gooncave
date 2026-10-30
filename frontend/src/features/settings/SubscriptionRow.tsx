import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/** One followed thing: the part that opens it, then its remove button. */
export function SubscriptionRow({
  open,
  removeLabel,
  removeDisabled,
  onRemove
}: {
  open: ReactNode;
  removeLabel: string;
  removeDisabled: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="list-group-item subscription-row">
      {open}
      <button
        type="button"
        className="btn btn-outline-light btn-sm subscription-row-remove"
        aria-label={removeLabel}
        title={removeLabel}
        disabled={removeDisabled}
        onClick={onRemove}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
