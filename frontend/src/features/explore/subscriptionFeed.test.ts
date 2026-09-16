import { describe, expect, it } from 'vitest';

import {
  collectSubscriptionPosts,
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
      maxRounds: 3,
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
