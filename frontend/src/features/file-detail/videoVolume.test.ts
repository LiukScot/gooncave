import { describe, expect, it } from 'vitest';

import { parseVideoVolume } from './videoVolume';

describe('parseVideoVolume', () => {
  it('keeps a stored volume inside the 0–1 range', () => {
    expect(parseVideoVolume('0')).toBe(0);
    expect(parseVideoVolume('0.35')).toBe(0.35);
    expect(parseVideoVolume('1')).toBe(1);
  });

  it('falls back to full volume when nothing is stored', () => {
    expect(parseVideoVolume(null)).toBe(1);
    expect(parseVideoVolume('')).toBe(1);
    expect(parseVideoVolume('   ')).toBe(1);
  });

  it('falls back to full volume on unusable values', () => {
    expect(parseVideoVolume('loud')).toBe(1);
    expect(parseVideoVolume('-0.5')).toBe(1);
    expect(parseVideoVolume('2')).toBe(1);
    expect(parseVideoVolume('NaN')).toBe(1);
  });
});
