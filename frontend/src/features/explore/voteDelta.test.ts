import { describe, expect, it } from 'vitest';

import { voteDelta } from './voteDelta';

describe('voteDelta', () => {
  it('moves one point on a first vote', () => {
    expect(voteDelta(null, 1)).toBe(1);
    expect(voteDelta(null, -1)).toBe(-1);
  });

  it('moves two points when switching sides', () => {
    expect(voteDelta(-1, 1)).toBe(2);
    expect(voteDelta(1, -1)).toBe(-2);
  });

  it('reverses the existing point when removing a vote', () => {
    expect(voteDelta(1, 0)).toBe(-1);
    expect(voteDelta(-1, 0)).toBe(1);
    expect(voteDelta(null, 0)).toBe(0);
  });
});
