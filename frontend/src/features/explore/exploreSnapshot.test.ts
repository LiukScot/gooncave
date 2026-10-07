import { describe, expect, it } from 'vitest';

import {
  readExploreQuery,
  readExploreSnapshot,
  writeExploreSnapshot,
  type ExploreSnapshot
} from './exploreSnapshot';

describe('Explore snapshot', () => {
  it('preserves the Subscribed cursor with the cards and scroll position', () => {
    const saved: ExploreSnapshot = {
      key: 'subscribed-search',
      query: {
        tagInput: '',
        tagQuery: '',
        sort: 'subscribed',
        popularWindow: 'day',
        popularDate: '2026-09-16',
        disabledSiteIds: []
      },
      posts: [],
      siteErrors: [],
      hasMore: true,
      streams: new Map(),
      subscriptionCursor: 'next-page',
      seen: { keys: new Set() },
      scrollY: 640
    };

    writeExploreSnapshot(saved);

    expect(readExploreQuery()?.sort).toBe('subscribed');
    expect(readExploreSnapshot('subscribed-search')).toMatchObject({
      subscriptionCursor: 'next-page',
      scrollY: 640
    });
    expect(readExploreSnapshot('different-search')).toBeNull();
  });
});
