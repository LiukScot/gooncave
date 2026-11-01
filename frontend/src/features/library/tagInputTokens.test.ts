import { describe, expect, it, vi } from 'vitest';

import {
  activeTagTerm,
  appendTagTerm,
  replaceActiveTagTerm,
  tagFilters
} from './tagInputTokens';

describe('activeTagTerm', () => {
  it('reads the term the caret is inside', () => {
    expect(activeTagTerm('female sol', 10)).toEqual({
      query: 'sol',
      prefix: ''
    });
  });

  it('reads a term the caret sits in the middle of', () => {
    expect(activeTagTerm('female solo', 9)).toEqual({
      query: 'solo',
      prefix: ''
    });
  });

  it('hands back the operator so it survives the replacement', () => {
    expect(activeTagTerm('-mal', 4)).toEqual({ query: 'mal', prefix: '-' });
    expect(activeTagTerm('~cat ~do', 8)).toEqual({ query: 'do', prefix: '~' });
  });

  it('treats a comma as a separator, like the search does', () => {
    expect(activeTagTerm('female,sol', 10)?.query).toBe('sol');
  });

  it('suggests nothing right after a separator', () => {
    expect(activeTagTerm('female ', 7)).toBeNull();
  });

  it('suggests nothing for a bare operator', () => {
    expect(activeTagTerm('-', 1)).toBeNull();
  });

  it('leaves the score metatag alone: its argument is a number', () => {
    expect(activeTagTerm('score:>5', 8)).toBeNull();
    expect(activeTagTerm('-score:>', 8)).toBeNull();
  });

  it('suggests nothing for an empty box', () => {
    expect(activeTagTerm('', 0)).toBeNull();
  });
});

describe('replaceActiveTagTerm', () => {
  it('swaps the term and leaves a space to type the next one', () => {
    expect(replaceActiveTagTerm('fem', 3, 'female')).toEqual({
      value: 'female ',
      caret: 7
    });
  });

  it('keeps the terms around it without doubling the separator', () => {
    expect(replaceActiveTagTerm('solo fem -male', 8, 'female')).toEqual({
      value: 'solo female -male',
      caret: 12
    });
  });

  it('puts the operator back', () => {
    expect(replaceActiveTagTerm('-mal', 4, 'male')).toEqual({
      value: '-male ',
      caret: 6
    });
  });
});

describe('appendTagTerm', () => {
  it('starts a query from an empty box', () => {
    expect(appendTagTerm('', 'wolf')).toBe('wolf');
    expect(appendTagTerm('   ', 'wolf')).toBe('wolf');
  });

  it('appends to what is already there', () => {
    expect(appendTagTerm('canine ~fox', 'wolf')).toBe('canine ~fox wolf');
  });

  it('replaces the same tag whatever operator it carried', () => {
    expect(appendTagTerm('-wolf canine', 'wolf')).toBe('canine wolf');
    expect(appendTagTerm('~wolf', 'wolf')).toBe('wolf');
    expect(appendTagTerm('wolf', 'wolf')).toBe('wolf');
  });
});

describe('tagFilters', () => {
  it('gives each term its own filter, and removing one keeps the others', () => {
    const apply = vi.fn();
    const filters = tagFilters('red, -blue  score:>5 red', apply);
    expect(filters.map(({ label }) => label)).toEqual(['red', '-blue', 'score:>5']);
    filters[1].clear();
    expect(apply).toHaveBeenLastCalledWith('red score:>5');
  });

  it('ends on an empty search when every filter is removed in one go', () => {
    const apply = vi.fn();
    tagFilters('red blue', apply).forEach((filter) => filter.clear());
    expect(apply).toHaveBeenLastCalledWith('');
  });
});
