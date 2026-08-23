import { useEffect, useState } from 'react';

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a fresh vote stays undoable in the UI before it is actually sent.
 */
export const VOTE_UNDO_WINDOW_MS = 5_000;

/**
 * Mirrors the backend cooldown. Only used to preview the countdown while a
 * vote sits in its undo window — once sent, the server's nextVoteAt wins.
 */
export const VOTE_COOLDOWN_MS = 24 * HOUR_MS;

/**
 * Whole hours left before `nextVoteAt` as "23h". Rounded, not ceiled: the
 * clock driving this only ticks every minute, so a deadline exactly 24h out
 * would otherwise read "25h" until the next tick. Floored at 1h so the last
 * stretch never reads "0h". Null when the file can be voted right now (never
 * voted, deadline passed, or an unparseable timestamp — the server rejects a
 * too-early vote anyway).
 */
export const formatVoteCooldown = (
  nextVoteAt: string | null,
  now: number
): string | null => {
  if (!nextVoteAt) return null;
  const deadline = Date.parse(nextVoteAt);
  if (Number.isNaN(deadline)) return null;
  const remaining = deadline - now;
  if (remaining <= 0) return null;
  return `${Math.max(1, Math.round(remaining / HOUR_MS))}h`;
};

/** Re-renders on an interval so a countdown built from Date.now stays fresh. */
export const useNow = (intervalMs: number) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(handle);
  }, [intervalMs]);
  return now;
};
