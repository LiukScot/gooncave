import { periodLabel } from './popularPeriod';

import type { ExploreWindow } from '@/api';

/** Under a tag search sorted by Score: the results stop at the period, not at the tag. */
export function PopularPeriodNote({
  window,
  date,
  onAllTime,
  onNewest
}: {
  window: Exclude<ExploreWindow, 'all'>;
  date: string;
  onAllTime: () => void;
  onNewest: () => void;
}) {
  return (
    <p className="explore-period-note text-muted-foreground text-sm" role="note">
      Score only shows posts from {periodLabel(window, date)}.{' '}
      <button type="button" className="btn btn-outline-light btn-sm" onClick={onAllTime}>
        Show all time
      </button>{' '}
      <button type="button" className="btn btn-outline-light btn-sm" onClick={onNewest}>
        Show newest
      </button>
    </p>
  );
}
