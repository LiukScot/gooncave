import { useEffect, useState } from 'react';

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a fresh star stays undoable in the UI before it is actually sent.
 */
export const STAR_UNDO_WINDOW_MS = 5_000;

/**
 * Mirrors the backend cooldown. Only used to preview the countdown while a
 * star sits in its undo window — once sent, the server's nextStarAt wins.
 */
export const STAR_COOLDOWN_MS = 24 * HOUR_MS;

/**
 * Whole hours left before `nextStarAt` as "23h". Rounded, not ceiled: the
 * clock driving this only ticks every minute, so a deadline exactly 24h out
 * would otherwise read "25h" until the next tick. Floored at 1h so the last
 * stretch never reads "0h". Null when the file can get a star right now (never
 * starred, deadline passed, or an unparseable timestamp — the server rejects a
 * too-early star anyway).
 */
export const formatStarCooldown = (
  nextStarAt: string | null,
  now: number
): string | null => {
  if (!nextStarAt) return null;
  const deadline = Date.parse(nextStarAt);
  if (Number.isNaN(deadline)) return null;
  const remaining = deadline - now;
  if (remaining <= 0) return null;
  return `${Math.max(1, Math.round(remaining / HOUR_MS))}h`;
};

export const canGiveStar = (
  file: { nextStarAt: string | null },
  now: number
): boolean => formatStarCooldown(file.nextStarAt, now) === null;

/** Re-renders on an interval so a countdown built from Date.now stays fresh. */
export const useNow = (intervalMs: number) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(handle);
  }, [intervalMs]);
  return now;
};
