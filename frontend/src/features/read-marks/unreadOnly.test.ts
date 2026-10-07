import { afterEach, describe, expect, it, vi } from 'vitest';

import { readUnreadOnly, writeUnreadOnly } from './unreadOnly';

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

describe('readUnreadOnly / writeUnreadOnly', () => {
  it('defaults to off when nothing was ever stored', () => {
    withStorage(memoryStorage());
    expect(readUnreadOnly('explore')).toBe(false);
  });

  it('round-trips both states', () => {
    withStorage(memoryStorage());
    expect(writeUnreadOnly('explore', true)).toBe(true);
    expect(readUnreadOnly('explore')).toBe(true);
    writeUnreadOnly('explore', false);
    expect(readUnreadOnly('explore')).toBe(false);
  });

  it('stays off when storage is blocked', () => {
    withStorage(throwingStorage);
    expect(readUnreadOnly('explore')).toBe(false);
    expect(writeUnreadOnly('explore', true)).toBe(false);
  });
});
