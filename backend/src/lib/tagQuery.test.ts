import { describe, expect, it } from 'bun:test';

import { isTagQueryEmpty, parseTagQuery } from './tagQuery';

describe('parseTagQuery', () => {
  it('reads bare terms as required', () => {
    expect(parseTagQuery('female solo')).toEqual({
      all: ['female', 'solo'],
      any: [],
      none: []
    });
  });

  it('still splits on commas, the separator the box accepted before', () => {
    expect(parseTagQuery('female, solo').all).toEqual(['female', 'solo']);
  });

  it('collects ~ terms into one alternative group', () => {
    expect(parseTagQuery('~cat ~dog')).toEqual({
      all: [],
      any: ['cat', 'dog'],
      none: []
    });
  });

  it('reads - terms as exclusions', () => {
    expect(parseTagQuery('female -male')).toEqual({
      all: ['female'],
      any: [],
      none: ['male']
    });
  });

  it('mixes the three buckets in one query', () => {
    expect(parseTagQuery('solo ~cat ~dog -male')).toEqual({
      all: ['solo'],
      any: ['cat', 'dog'],
      none: ['male']
    });
  });

  it('normalises spacing and case the way stored tags are normalised', () => {
    expect(parseTagQuery('-Blue_Eyes').none).toEqual(['blue_eyes']);
  });

  it('drops duplicates inside a bucket', () => {
    expect(parseTagQuery('cat cat ~dog ~dog').all).toEqual(['cat']);
    expect(parseTagQuery('cat cat ~dog ~dog').any).toEqual(['dog']);
  });

  it('drops a bare operator instead of searching for it', () => {
    expect(isTagQueryEmpty(parseTagQuery('- ~'))).toBe(true);
  });

  it('treats an empty or missing value as no filter', () => {
    expect(isTagQueryEmpty(parseTagQuery(''))).toBe(true);
    expect(isTagQueryEmpty(parseTagQuery(undefined))).toBe(true);
  });
});
