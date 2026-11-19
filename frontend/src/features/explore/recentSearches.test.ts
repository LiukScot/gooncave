import { describe, expect, it } from 'vitest';

import { RECENT_SEARCH_LIMIT, withRecentSearch } from './recentSearches';

describe('withRecentSearch', () => {
  it('moves a repeated search to the front instead of listing it twice', () => {
    expect(withRecentSearch(['fox', 'wolf'], ' wolf ')).toEqual(['wolf', 'fox']);
  });

  it('keeps only the newest searches within the limit', () => {
    const full = Array.from({ length: RECENT_SEARCH_LIMIT }, (_, index) => `tag${index}`);
    const next = withRecentSearch(full, 'new');
    expect(next).toHaveLength(RECENT_SEARCH_LIMIT);
    expect(next[0]).toBe('new');
    expect(next).not.toContain(`tag${RECENT_SEARCH_LIMIT - 1}`);
  });

  it('ignores an empty search', () => {
    expect(withRecentSearch(['fox'], '  ')).toEqual(['fox']);
  });
});
