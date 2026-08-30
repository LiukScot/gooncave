import { describe, expect, it } from 'vitest';

import {
  applyBlacklistToQuery,
  effectiveBlacklist,
  isBlacklisted,
  parseBlacklistInput
} from './blacklist';

describe('parseBlacklistInput', () => {
  it('splits on newlines, commas and spaces', () => {
    expect(parseBlacklistInput('gore\nscat, young  vore')).toEqual([
      'gore',
      'scat',
      'young',
      'vore'
    ]);
  });

  it('normalises case and dedupes', () => {
    expect(parseBlacklistInput('Blue_Eyes\nblue_eyes')).toEqual(['blue_eyes']);
  });

  it('is empty for a blank list', () => {
    expect(parseBlacklistInput('  \n ')).toEqual([]);
  });
});

describe('effectiveBlacklist', () => {
  it('drops tags the search asks for, whatever the operator', () => {
    expect(effectiveBlacklist(['gore', 'young'], 'wolf ~gore -male')).toEqual([
      'young'
    ]);
  });

  it('keeps everything when nothing is searched', () => {
    expect(effectiveBlacklist(['gore'], '')).toEqual(['gore']);
  });
});

describe('applyBlacklistToQuery', () => {
  it('appends exclusions to the query', () => {
    expect(applyBlacklistToQuery('wolf', ['gore', 'young'])).toBe(
      'wolf -gore -young'
    );
  });

  it('leaves an empty query without a leading space', () => {
    expect(applyBlacklistToQuery('', ['gore'])).toBe('-gore');
  });

  it('returns the query untouched with an empty list', () => {
    expect(applyBlacklistToQuery('wolf', [])).toBe('wolf');
  });
});

describe('isBlacklisted', () => {
  it('matches a single tag', () => {
    expect(isBlacklisted([{ tag: 'wolf' }, { tag: 'gore' }], new Set(['gore'])))
      .toBe(true);
  });

  it('normalises the post tags before matching', () => {
    expect(isBlacklisted([{ tag: 'Blue Eyes' }], new Set(['blue_eyes']))).toBe(
      true
    );
  });

  it('keeps posts with no listed tag', () => {
    expect(isBlacklisted([{ tag: 'wolf' }], new Set(['gore']))).toBe(false);
  });
});
