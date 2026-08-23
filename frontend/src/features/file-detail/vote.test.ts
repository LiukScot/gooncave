import { describe, expect, it } from 'vitest';

import { formatVoteCooldown } from './vote';

const at = (msFromNow: number) => new Date(1_000_000 + msFromNow).toISOString();
const now = 1_000_000;

describe('formatVoteCooldown', () => {
  it('returns null when the file has never been voted', () => {
    expect(formatVoteCooldown(null, now)).toBeNull();
  });

  it('returns null once the deadline has passed', () => {
    expect(formatVoteCooldown(at(-1), now)).toBeNull();
    expect(formatVoteCooldown(at(0), now)).toBeNull();
  });

  it('returns null for an unparseable timestamp', () => {
    expect(formatVoteCooldown('not-a-date', now)).toBeNull();
  });

  it('reports whole hours only', () => {
    expect(formatVoteCooldown(at(24 * 3_600_000), now)).toBe('24h');
    expect(formatVoteCooldown(at(2 * 3_600_000), now)).toBe('2h');
  });

  it('does not overshoot when the minute-clock lags the deadline', () => {
    expect(formatVoteCooldown(at(24 * 3_600_000 + 45_000), now)).toBe('24h');
  });

  it('never reads as 0h in the last stretch', () => {
    expect(formatVoteCooldown(at(23 * 3_600_000 + 41 * 60_000), now)).toBe(
      '24h'
    );
    expect(formatVoteCooldown(at(30_000), now)).toBe('1h');
  });
});
