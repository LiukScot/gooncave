import { describe, expect, it } from 'vitest';

import { historySince } from './historyPeriod';

describe('historySince', () => {
  const now = new Date('2026-11-20T12:00:00.000Z');

  it('counts each period back from now', () => {
    expect(historySince('day', now)).toBe('2026-11-19T12:00:00.000Z');
    expect(historySince('week', now)).toBe('2026-11-13T12:00:00.000Z');
  });

  it('sets no bound for all time', () => {
    expect(historySince('all', now)).toBeNull();
  });
});
