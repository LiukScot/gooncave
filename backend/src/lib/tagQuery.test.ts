import { describe, expect, it } from 'bun:test';

import { isTagQueryEmpty, parseTagQuery } from './tagQuery';

describe('parseTagQuery', () => {
  it('reads bare terms as required', () => {
    expect(parseTagQuery('female solo')).toEqual({
      all: ['female', 'solo'],
      any: [],
      none: [],
      score: []
    });
  });

  it('still splits on commas, the separator the box accepted before', () => {
    expect(parseTagQuery('female, solo').all).toEqual(['female', 'solo']);
  });

  it('collects ~ terms into one alternative group', () => {
    expect(parseTagQuery('~cat ~dog')).toEqual({
      all: [],
      any: ['cat', 'dog'],
      none: [],
      score: []
    });
  });

  it('reads - terms as exclusions', () => {
    expect(parseTagQuery('female -male')).toEqual({
      all: ['female'],
      any: [],
      none: ['male'],
      score: []
    });
  });

  it('mixes the three buckets in one query', () => {
    expect(parseTagQuery('solo ~cat ~dog -male')).toEqual({
      all: ['solo'],
      any: ['cat', 'dog'],
      none: ['male'],
      score: []
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

describe('parseTagQuery score metatag', () => {
  it('reads every comparison', () => {
    expect(parseTagQuery('score:>5').score).toEqual([
      { op: '>', value: 5, negated: false }
    ]);
    expect(parseTagQuery('score:>=5').score[0].op).toBe('>=');
    expect(parseTagQuery('score:<5').score[0].op).toBe('<');
    expect(parseTagQuery('score:<=5').score[0].op).toBe('<=');
    expect(parseTagQuery('score:=5').score[0].op).toBe('=');
  });

  it('means equality when no comparison is given', () => {
    expect(parseTagQuery('score:3').score).toEqual([
      { op: '=', value: 3, negated: false }
    ]);
  });

  it('reads a negative threshold', () => {
    expect(parseTagQuery('score:<-2').score).toEqual([
      { op: '<', value: -2, negated: false }
    ]);
  });

  it('negates with the same prefix tags use', () => {
    expect(parseTagQuery('-score:>5').score).toEqual([
      { op: '>', value: 5, negated: true }
    ]);
  });

  it('keeps several thresholds so they can narrow each other', () => {
    expect(parseTagQuery('score:>0 score:<10').score).toHaveLength(2);
  });

  it('never joins an alternative group, the way booru metatags do not', () => {
    const query = parseTagQuery('~score:>5 ~cat');
    expect(query.any).toEqual(['cat']);
    expect(query.score).toHaveLength(1);
  });

  it('does not treat the metatag as a tag', () => {
    const query = parseTagQuery('score:>5 female');
    expect(query.all).toEqual(['female']);
  });

  it('drops a score term that names no number', () => {
    expect(isTagQueryEmpty(parseTagQuery('score: score:> score:abc'))).toBe(
      true
    );
  });

  it('is case-insensitive on the metatag name', () => {
    expect(parseTagQuery('SCORE:>2').score[0].value).toBe(2);
  });
});
