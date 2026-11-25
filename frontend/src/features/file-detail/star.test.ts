import { describe, expect, it } from 'vitest';

import { canGiveStar, formatStarCooldown } from './star';

const at = (msFromNow: number) => new Date(1_000_000 + msFromNow).toISOString();
const now = 1_000_000;

it('blocks keyboard votes during cooldown', () => {
  expect(canGiveStar({ nextStarAt: at(60_000) }, now)).toBe(false);
  expect(canGiveStar({ nextStarAt: at(-1) }, now)).toBe(true);
});

describe('formatStarCooldown', () => {
  it('returns null when the file has never been voted', () => {
    expect(formatStarCooldown(null, now)).toBeNull();
  });

  it('returns null once the deadline has passed', () => {
    expect(formatStarCooldown(at(-1), now)).toBeNull();
    expect(formatStarCooldown(at(0), now)).toBeNull();
  });

  it('returns null for an unparseable timestamp', () => {
    expect(formatStarCooldown('not-a-date', now)).toBeNull();
  });

  it('reports whole hours only', () => {
    expect(formatStarCooldown(at(24 * 3_600_000), now)).toBe('24h');
    expect(formatStarCooldown(at(2 * 3_600_000), now)).toBe('2h');
  });

  it('does not overshoot when the minute-clock lags the deadline', () => {
    expect(formatStarCooldown(at(24 * 3_600_000 + 45_000), now)).toBe('24h');
  });

  it('never reads as 0h in the last stretch', () => {
    expect(formatStarCooldown(at(23 * 3_600_000 + 41 * 60_000), now)).toBe(
      '24h'
    );
    expect(formatStarCooldown(at(30_000), now)).toBe('1h');
  });
});
