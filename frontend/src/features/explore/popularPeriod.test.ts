import { describe, expect, it } from 'vitest';

import {
  isCurrentPeriod,
  periodLabel,
  shiftAnchor,
  todayIso
} from './popularPeriod';

describe('shiftAnchor', () => {
  it('steps a day, a week and a month', () => {
    expect(shiftAnchor('day', '2026-08-01', -1)).toBe('2026-07-31');
    expect(shiftAnchor('week', '2026-08-28', 1)).toBe('2026-09-04');
    expect(shiftAnchor('month', '2026-08-28', -1)).toBe('2026-07-28');
  });

  it('clamps a month step onto a shorter month', () => {
    expect(shiftAnchor('month', '2026-03-31', -1)).toBe('2026-02-28');
  });
});

describe('isCurrentPeriod', () => {
  it('is true for the period containing today, so next is disabled', () => {
    expect(isCurrentPeriod('day', '2026-08-28', '2026-08-28')).toBe(true);
    expect(isCurrentPeriod('day', '2026-08-27', '2026-08-28')).toBe(false);
  });

  it('treats a week as current until stepping past today', () => {
    expect(isCurrentPeriod('week', '2026-08-24', '2026-08-28')).toBe(true);
    expect(isCurrentPeriod('week', '2026-08-17', '2026-08-28')).toBe(false);
  });
});

describe('periodLabel', () => {
  it('names a day, a month and a week span', () => {
    expect(periodLabel('day', '2026-08-28', 'en-GB')).toBe('28 Aug 2026');
    expect(periodLabel('month', '2026-08-28', 'en-GB')).toBe('August 2026');
    // 2026-08-28 is a Friday: the week runs Monday to Sunday.
    expect(periodLabel('week', '2026-08-28', 'en-GB')).toBe(
      '24 Aug – 30 Aug 2026'
    );
  });
});

describe('todayIso', () => {
  it('reads the date in UTC', () => {
    expect(todayIso(new Date('2026-08-28T23:30:00.000Z'))).toBe('2026-08-28');
  });
});
