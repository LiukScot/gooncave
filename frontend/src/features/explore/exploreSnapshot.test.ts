import { describe, expect, it } from 'vitest';

import {
  exploreReturnScrollY,
  readExploreQuery,
  readExploreSnapshot,
  writeExploreSnapshot,
  type ExploreSnapshot
} from './exploreSnapshot';

describe('Explore snapshot', () => {
  it('keeps the grid position while a detail has moved the window to the top', () => {
    expect(exploreReturnScrollY(0, 720, true)).toBe(720);
    expect(exploreReturnScrollY(810, 720, false)).toBe(810);
  });

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
