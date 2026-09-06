import { describe, expect, it } from 'vitest';

import { anchorIndexOf } from './navSequence';

const results = ['s:1', 's:2', 's:3', 's:4'];

describe('anchorIndexOf', () => {
  it('follows the open post while the reader moves along the sequence', () => {
    expect(anchorIndexOf(results, 's:2', 's:2')).toBe(1);
  });

  it('holds the anchor when the open post is in the sequence too', () => {
    // The case a comic makes ordinary: its pages are results in their own
    // right, so a page opened from the pool navigator is findable here. The
    // reader is still standing at s:2, and the next step is s:3.
    expect(anchorIndexOf(results, 's:4', 's:2')).toBe(1);
  });

  it('holds the anchor when the open post is outside the sequence', () => {
    expect(anchorIndexOf(results, 's:99', 's:2')).toBe(1);
  });

  it('falls back to the open post when nothing is anchored yet', () => {
    expect(anchorIndexOf(results, 's:3', null)).toBe(2);
  });

  it('falls back when the anchor is no longer in the sequence', () => {
    expect(anchorIndexOf(results, 's:3', 's:99')).toBe(2);
  });

  it('reports nothing to step from when neither is in the sequence', () => {
    expect(anchorIndexOf(results, 's:99', 's:98')).toBe(-1);
    expect(anchorIndexOf(results, null, null)).toBe(-1);
  });
});
