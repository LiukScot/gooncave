import type { PopularWindow } from './types';

export type DateRange = { start: string; end: string };

const toDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const toIso = (date: Date): string => date.toISOString().slice(0, 10);

/** Today in UTC, the default anchor for a popular search. */
export const todayIso = (now: Date = new Date()): string =>
  now.toISOString().slice(0, 10);

/**
 * Calendar period containing `anchor`, inclusive at both ends.
 *
 * Periods are aligned to the calendar rather than counted back from the
 * anchor, which is what makes "previous week" mean the week before this one
 * instead of "eight to fourteen days ago". Weeks start on Monday (ISO).
 */
export const windowRange = (
  window: PopularWindow,
  anchor: string
): DateRange => {
  const date = toDate(anchor);
  if (window === 'day') return { start: anchor, end: anchor };
  if (window === 'week') {
    const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
    const start = new Date(date);
    start.setUTCDate(start.getUTCDate() - weekday);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    return { start: toIso(start), end: toIso(end) };
  }
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  );
  const end = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  );
  return { start: toIso(start), end: toIso(end) };
};

/**
 * The anchor one period earlier or later. Stepping by calendar unit, not by
 * a fixed number of days, so month steps land on the same day-of-month and
 * a 31st never skips a short month.
 */
export const shiftAnchor = (
  window: PopularWindow,
  anchor: string,
  direction: -1 | 1
): string => {
  const date = toDate(anchor);
  if (window === 'day') {
    date.setUTCDate(date.getUTCDate() + direction);
  } else if (window === 'week') {
    date.setUTCDate(date.getUTCDate() + 7 * direction);
  } else {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + direction);
    const lastDay = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
    ).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }
  return toIso(date);
};

/**
 * The range as a booru `date:` metatag.
 *
 * A one-day period is written as a single date, not `X..X`: e621 answers an
 * equal-bounded range with nothing at all, so "popular on this day" would
 * come back empty.
 */
export const dateMetatag = (range: DateRange): string =>
  range.start === range.end
    ? `date:${range.start}`
    : `date:${range.start}..${range.end}`;
