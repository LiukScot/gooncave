import { describe, expect, it } from 'vitest';

import {
  collectSubscriptionPosts,
  loadSubscriptionPosts,
  searchSortForTag,
  subscriptionActionState,
  subscriptionReasons
} from './subscriptionFeed';

import type { ExplorePost } from '@/api';


const post = (remoteId: string): ExplorePost =>
  ({ remoteId }) as ExplorePost;

describe('collectSubscriptionPosts', () => {
  it('advances the index cursor until a filtered page is filled', async () => {
    const pages = [
      {
        posts: [post('hidden'), post('first')],
        hasMore: true,
        nextCursor: 'second-page'
      },
      {
        posts: [post('second')],
        hasMore: false,
        nextCursor: 'end'
      }
    ];
    const cursors: Array<string | null> = [];

    const result = await collectSubscriptionPosts({
      cursor: null,
      target: 2,
      signal: new AbortController().signal,
      fetchPage: async (cursor) => {
        cursors.push(cursor);
        return pages.shift()!;
      },
      keep: (entry) => entry.remoteId !== 'hidden'
    });

    expect(cursors).toEqual([null, 'second-page']);
    expect(result.posts.map((entry) => entry.remoteId)).toEqual([
      'first',
      'second'
    ]);
    expect(result.hasMore).toBe(false);
  });

  it('keeps reading the local index until it fills an unread page', async () => {
    let page = 0;

    const result = await collectSubscriptionPosts({
      cursor: null,
      target: 2,
      signal: new AbortController().signal,
      fetchPage: async () => {
        page += 1;
        return {
          posts: [post(page < 7 ? `read-${page}` : `unread-${page}`)],
          hasMore: page < 8,
          nextCursor: page < 8 ? `page-${page + 1}` : null
        };
      },
      keep: (entry) => entry.remoteId.startsWith('unread-')
    });

    expect(page).toBe(8);
    expect(result.posts.map((entry) => entry.remoteId)).toEqual([
      'unread-7',
      'unread-8'
    ]);
    expect(result.hasMore).toBe(false);
  });

  it('refreshes before reading an existing partial index', async () => {
    const calls: string[] = [];
    let ready = false;

    const result = await loadSubscriptionPosts({
      cursor: null,
      target: 40,
      signal: new AbortController().signal,
      refresh: async () => {
        calls.push('refresh');
        ready = true;
        return { errors: [] };
      },
      fetchPage: async () => {
        calls.push('read');
        return {
          posts: [post('booru'), post('furaffinity')],
          hasMore: false,
          nextCursor: null,
          ready
        };
      },
      keep: () => true
    });

    expect(calls).toEqual(['read', 'refresh', 'read']);
    expect(result.posts.map((entry) => entry.remoteId)).toEqual([
      'booru',
      'furaffinity'
    ]);
    expect(result.refreshed).toEqual({ errors: [] });
    expect(result.refreshError).toBeNull();
  });

  it('uses a ready local index without waiting for a remote refresh', async () => {
    const calls: string[] = [];

    const result = await loadSubscriptionPosts({
      cursor: null,
      target: 40,
      signal: new AbortController().signal,
      refresh: async () => {
        calls.push('refresh');
        return { errors: [] };
      },
      fetchPage: async () => {
        calls.push('read');
        return {
          posts: [post('cached')],
          hasMore: false,
          nextCursor: null,
          ready: true
        };
      },
      keep: () => true
    });

    expect(calls).toEqual(['read']);
    expect(result.posts.map((entry) => entry.remoteId)).toEqual(['cached']);
    expect(result.refreshed).toBeNull();
    expect(result.refreshError).toBeNull();
  });

  it('keeps the cursor before a page that is still not indexed deeply enough', async () => {
    const cursors: Array<string | null> = [];

    const result = await loadSubscriptionPosts({
      cursor: 'cursor-before-gap',
      target: 40,
      signal: new AbortController().signal,
      refresh: async () => ({ errors: [] }),
      fetchPage: async (cursor) => {
        cursors.push(cursor);
        return {
          posts: [post('furaffinity-only')],
          hasMore: true,
          nextCursor: 'cursor-after-gap',
          ready: false
        };
      },
      keep: () => true
    });

    expect(cursors).toEqual(['cursor-before-gap', 'cursor-before-gap']);
    expect(result.posts).toEqual([]);
    expect(result.nextCursor).toBe('cursor-before-gap');
    expect(result.hasMore).toBe(true);
  });

  it('keeps a partial local index visible when its refresh fails', async () => {
    const failure = new Error('refresh unavailable');

    const result = await loadSubscriptionPosts({
      cursor: null,
      target: 40,
      signal: new AbortController().signal,
      refresh: async () => {
        throw failure;
      },
      fetchPage: async () => ({
        posts: [post('cached-furaffinity')],
        hasMore: false,
        nextCursor: null,
        ready: false
      }),
      keep: () => true
    });

    expect(result.posts.map((entry) => entry.remoteId)).toEqual([
      'cached-furaffinity'
    ]);
    expect(result.refreshed).toBeNull();
    expect(result.refreshError).toBe(failure);
  });
});

describe('subscriptionActionState', () => {
  it('offers removal for an equivalent tag that is already subscribed', () => {
    expect(subscriptionActionState('  Red Fox  ', ['red_fox'])).toEqual({
      subscribed: true,
      label: 'Remove subscription'
    });
  });

  it('offers subscription for a new tag', () => {
    expect(subscriptionActionState('wolf', ['red_fox'])).toEqual({
      subscribed: false,
      label: 'Subscribe'
    });
  });
});

describe('subscriptionReasons', () => {
  it('returns every subscribed tag carried by a search-feed post', () => {
    const taggedPost = {
      engine: 'e621',
      tags: [
        { tag: 'red_fox', category: 'species' },
        { tag: 'blue_eyes', category: 'general' }
      ],
      uploader: 'someone'
    } as ExplorePost;

    expect(
      subscriptionReasons(taggedPost, ['Blue Eyes', 'wolf', 'red_fox'])
    ).toEqual(['Blue Eyes', 'red_fox']);
  });

  it('returns the artist for a FurAffinity subscription post', () => {
    const artistPost = {
      engine: 'furaffinity',
      tags: [{ tag: 'wolf', category: 'species' }],
      uploader: '~Peyote'
    } as ExplorePost;

    expect(subscriptionReasons(artistPost, ['wolf'])).toEqual(['Peyote']);
  });
});

describe('searchSortForTag', () => {
  it('moves every tag search to New', () => {
    expect(searchSortForTag('popular')).toBe('new');
    expect(searchSortForTag('hot')).toBe('new');
  });

  it('moves a subscribed-feed tag search to New', () => {
    expect(searchSortForTag('subscribed')).toBe('new');
  });
});
