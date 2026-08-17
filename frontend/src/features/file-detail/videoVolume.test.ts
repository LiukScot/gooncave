import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseVideoVolume,
  readVideoSound,
  writeVideoSound
} from './videoVolume';

/** Minimal stand-in for the only storage methods these helpers touch. */
const memoryStorage = (initial: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  };
};

const throwingStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  }
};

const withStorage = (localStorage: unknown) =>
  vi.stubGlobal('window', { localStorage });

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe('readVideoSound / writeVideoSound', () => {
  it('round-trips a volume without touching mute', () => {
    withStorage(memoryStorage());
    expect(writeVideoSound({ volume: 0.42, muted: false })).toBe(true);
    expect(readVideoSound()).toEqual({ volume: 0.42, muted: false });
  });

  it('round-trips mute while keeping the level it was muted at', () => {
    withStorage(memoryStorage());
    writeVideoSound({ volume: 0.3, muted: true });
    expect(readVideoSound()).toEqual({ volume: 0.3, muted: true });
  });

  it('reads a stored zero as silence rather than as "unset"', () => {
    withStorage(memoryStorage());
    writeVideoSound({ volume: 0, muted: false });
    expect(readVideoSound().volume).toBe(0);
  });

  it('defaults to full volume when nothing was ever stored', () => {
    withStorage(memoryStorage());
    expect(readVideoSound()).toEqual({ volume: 1, muted: false });
  });

  it('falls back to full volume when storage is blocked', () => {
    withStorage(throwingStorage);
    expect(readVideoSound()).toEqual({ volume: 1, muted: false });
  });

  it('reports failure instead of throwing when storage is blocked', () => {
    withStorage(throwingStorage);
    expect(writeVideoSound({ volume: 0.5, muted: false })).toBe(false);
  });
});
