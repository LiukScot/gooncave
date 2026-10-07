import { describe, expect, it } from 'vitest';

import {
  forgetExploreSnapshot,
  readExploreQuery,
  readExploreSnapshot,
  rememberExploreQuery,
  writeExploreSnapshot,
  type ExploreSnapshot
} from './exploreSnapshot';

describe('Explore snapshot', () => {
  it('preserves the Subscribed cursor with the cards and scroll position', () => {
    const saved: ExploreSnapshot = {
      key: 'subscribed-search',
      posts: [],
      siteErrors: [],
      hasMore: true,
      streams: new Map(),
      subscriptionCursor: 'next-page',
      seen: { keys: new Set() },
      scrollY: 640
    };

    writeExploreSnapshot(saved);

    expect(readExploreSnapshot('subscribed-search')).toMatchObject({
      subscriptionCursor: 'next-page',
      scrollY: 640
    });
    expect(readExploreSnapshot('different-search')).toBeNull();
  });

  it('resumes the last search even when no results were kept for it', () => {
    writeExploreSnapshot({
      key: 'new-search',
      posts: [],
      siteErrors: [],
      hasMore: false,
      streams: new Map(),
      subscriptionCursor: null,
      seen: { keys: new Set() },
      scrollY: 0
    });
    rememberExploreQuery({
      tagInput: '',
      tagQuery: '',
      sort: 'popular',
      popularWindow: 'week',
      popularDate: '2026-09-16',
      disabledSiteIds: []
    });

    expect(readExploreQuery()).toMatchObject({ sort: 'popular', popularWindow: 'week' });
  });

  it('forgets the search and the results for the next account', () => {
    rememberExploreQuery({
      tagInput: 'cat',
      tagQuery: 'cat',
      sort: 'hot',
      popularWindow: 'day',
      popularDate: '2026-09-16',
      disabledSiteIds: []
    });
    writeExploreSnapshot({
      key: 'cat-search',
      posts: [],
      siteErrors: [],
      hasMore: false,
      streams: new Map(),
      subscriptionCursor: null,
      seen: { keys: new Set() },
      scrollY: 0
    });

    forgetExploreSnapshot();

    expect(readExploreQuery()).toBeNull();
    expect(readExploreSnapshot('cat-search')).toBeNull();
  });
});
