import { describe, expect, it } from 'bun:test';

import {
  buildImplicationClosure,
  isUnusableConsequent,
  resolveAlias
} from './tagAliases';

const aliasMap = (pairs: [string, string][]) => new Map(pairs);
const implicationMap = (pairs: [string, string[]][]) =>
  new Map(pairs.map(([tag, parents]) => [tag, new Set(parents)]));

describe('isUnusableConsequent', () => {
  it('rejects the bucket e621 parks unwanted tags in', () => {
    expect(isUnusableConsequent('invalid_tag')).toBe(true);
    expect(isUnusableConsequent('susie_(disambiguation)')).toBe(true);
  });

  it('accepts an ordinary tag', () => {
    expect(isUnusableConsequent('female')).toBe(false);
    expect(isUnusableConsequent('susie_(deltarune)')).toBe(false);
  });
});

describe('resolveAlias', () => {
  it('maps a tag to its consequent', () => {
    expect(resolveAlias('1girls', aliasMap([['1girls', 'female']]))).toBe(
      'female'
    );
  });

  it('leaves an unaliased tag alone', () => {
    expect(resolveAlias('female', aliasMap([]))).toBe('female');
  });

  it('follows a chain to its end', () => {
    const aliases = aliasMap([
      ['1girl', '1girls'],
      ['1girls', 'female']
    ]);
    expect(resolveAlias('1girl', aliases)).toBe('female');
  });

  it('stops before an unusable consequent instead of adopting it', () => {
    expect(resolveAlias('2d', aliasMap([['2d', 'invalid_tag']]))).toBe('2d');
  });

  it('breaks a cycle instead of looping forever', () => {
    const aliases = aliasMap([
      ['a', 'b'],
      ['b', 'a']
    ]);
    expect(resolveAlias('a', aliases)).toBe('b');
  });
});

describe('buildImplicationClosure', () => {
  it('carries a chain all the way up', () => {
    const closure = buildImplicationClosure(
      implicationMap([
        ['husky', ['dog']],
        ['dog', ['canine']],
        ['canine', ['mammal']]
      ])
    );
    expect([...closure.get('husky')!].sort()).toEqual([
      'canine',
      'dog',
      'mammal'
    ]);
    expect([...closure.get('dog')!].sort()).toEqual(['canine', 'mammal']);
  });

  it('merges several parents of the same tag', () => {
    const closure = buildImplicationClosure(
      implicationMap([
        ['big_balls', ['balls']],
        ['balls', ['genitals']]
      ])
    );
    expect([...closure.get('big_balls')!].sort()).toEqual([
      'balls',
      'genitals'
    ]);
  });

  it('never lists a tag as its own ancestor', () => {
    const closure = buildImplicationClosure(
      implicationMap([
        ['a', ['b']],
        ['b', ['a']]
      ])
    );
    expect(closure.get('a')!.has('a')).toBe(false);
  });

  it('gives every member of a cycle the whole ring', () => {
    // Caching a set built while its own traversal was still on the stack
    // used to leave `c` with only `a`, losing `b` for search and for the
    // implied-tag list.
    const closure = buildImplicationClosure(
      implicationMap([
        ['a', ['b']],
        ['b', ['c']],
        ['c', ['a']]
      ])
    );
    expect([...closure.get('a')!].sort()).toEqual(['b', 'c']);
    expect([...closure.get('b')!].sort()).toEqual(['a', 'c']);
    expect([...closure.get('c')!].sort()).toEqual(['a', 'b']);
  });

  it('keeps a tail hanging off a cycle complete', () => {
    const closure = buildImplicationClosure(
      implicationMap([
        ['husky', ['a']],
        ['a', ['b']],
        ['b', ['a']]
      ])
    );
    expect([...closure.get('husky')!].sort()).toEqual(['a', 'b']);
  });
});
