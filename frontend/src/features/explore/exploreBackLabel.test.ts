import { describe, expect, it } from 'vitest';

import { exploreBackLabel } from './useExploreController';

describe('exploreBackLabel', () => {
  it('names the page a post was opened on', () => {
    expect(exploreBackLabel('subscribed', false)).toBe('Back to subscriptions');
    expect(exploreBackLabel('history', false)).toBe('Back to history');
    expect(exploreBackLabel('new', false)).toBe('Back to explore');
    expect(exploreBackLabel('subscribed', true)).toBe('Back to pool');
  });
});
