import type { ExploreWindow } from '@/api';

const DAY_MS = 24 * 60 * 60 * 1000;
const SPAN_DAYS: Record<Exclude<ExploreWindow, 'all'>, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365
};

/** The earliest read time History shows for `window`, counted back from `now`; null for all time. */
export const historySince = (window: ExploreWindow, now: Date = new Date()): string | null =>
  window === 'all' ? null : new Date(now.getTime() - SPAN_DAYS[window] * DAY_MS).toISOString();
