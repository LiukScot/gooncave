import { ChevronDown, ChevronUp } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';

/** Rows shown before "Show more" appears. */
export const FIRST_ROWS = 8;

/** A segmented list of rows that shows the first few and folds the rest. */
export function ShowMoreList<T>({
  items,
  getKey,
  renderRow,
  limit = FIRST_ROWS,
  label
}: {
  items: T[];
  getKey: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  limit?: number;
  label: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const folded = items.length > limit;
  const shown = folded && !expanded ? items.slice(0, limit) : items;
  const hidden = items.length - shown.length;
  return (
    <>
      <div className="list-group list-group-segmented mb-2">
        {shown.map((item) => (
          <Fragment key={getKey(item)}>{renderRow(item)}</Fragment>
        ))}
      </div>
      {folded ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm mb-3"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <ChevronUp className="size-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-4" aria-hidden="true" />
          )}
          {expanded ? 'Show less' : `Show more (${hidden} ${label})`}
        </button>
      ) : null}
    </>
  );
}
