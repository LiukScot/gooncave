import { describe, expect, it } from 'vitest';

import { ratingLabel } from './rating';

describe('ratingLabel', () => {
  it('reads e621 letters the way e621 means them', () => {
    expect(ratingLabel('s', 'e621')).toBe('Safe');
    expect(ratingLabel('q', 'e621')).toBe('Questionable');
    expect(ratingLabel('e', 'e621')).toBe('Explicit');
  });

  it('reads danbooru letters the way danbooru means them', () => {
    expect(ratingLabel('g', 'danbooru')).toBe('General');
    expect(ratingLabel('s', 'danbooru')).toBe('Sensitive');
    expect(ratingLabel('e', 'danbooru')).toBe('Explicit');
  });

  it('capitalises a rating an engine spells out in full', () => {
    expect(ratingLabel('sensitive', 'gelbooru')).toBe('Sensitive');
  });

  it('takes the letter in either case', () => {
    expect(ratingLabel('E', 'e621')).toBe('Explicit');
  });
});
