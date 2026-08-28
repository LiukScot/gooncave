import type { ExploreWindow } from '@/api';

/** Today in UTC, which is the calendar the boorus date their posts in. */
export const todayIso = (now: Date = new Date()): string =>
  now.toISOString().slice(0, 10);

const toDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const toIso = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * The anchor one period earlier or later, stepping by calendar unit so a
 * month step keeps the day-of-month and never skips a short month.
 *
 * Mirrors the backend's own stepping: both sides have to agree on what
 * "previous week" means or the arrows would walk a different calendar from
 * the results they fetch.
 */
export const shiftAnchor = (
  window: ExploreWindow,
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

/** Whether stepping forward would land past the current period. */
export const isCurrentPeriod = (
  window: ExploreWindow,
  anchor: string,
  today = todayIso()
): boolean => shiftAnchor(window, anchor, 1) > today;

/**
 * What the arrows sit around: "28 Aug 2026" for a day, the month and year
 * for a month, and the week's own days when it does not fit in one month.
 */
export const periodLabel = (
  window: ExploreWindow,
  anchor: string,
  locale?: string
): string => {
  const date = toDate(anchor);
  if (window === 'day') {
    return date.toLocaleDateString(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    });
  }
  if (window === 'month') {
    return date.toLocaleDateString(locale, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC'
    });
  }
  const weekday = (date.getUTCDay() + 6) % 7;
  const start = new Date(date);
  start.setUTCDate(start.getUTCDate() - weekday);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const startLabel = start.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC'
  });
  const endLabel = end.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  });
  return `${startLabel} – ${endLabel}`;
};
