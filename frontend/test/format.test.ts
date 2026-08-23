import { describe, expect, it } from 'vitest';

import { formatDuration } from '../src/lib/format';

describe('formatDuration', () => {
  it('returns an empty string for missing or non-positive values', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });

  it('pads seconds under a minute', () => {
    expect(formatDuration(3_200)).toBe('0:03');
    expect(formatDuration(45_000)).toBe('0:45');
  });

  it('rolls seconds into minutes and minutes into hours', () => {
    expect(formatDuration(125_000)).toBe('2:05');
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });

  it('rounds to the nearest second', () => {
    expect(formatDuration(1_600)).toBe('0:02');
  });
});
