import { describe, expect, it } from 'vitest';

import {
  collectSubscriptionPosts,
  groupFeedByDay,
  subscriptionActionState,
  subscriptionReasons
} from './subscriptionFeed';

import type { ExplorePost } from '@/api';


const post = (remoteId: string): ExplorePost =>
  ({ remoteId }) as ExplorePost;

describe('collectSubscriptionPosts', () => {
  it('follows the cursor until a filtered page is filled', async () => {
    const pages = [
      {
        posts: [post('hidden'), post('first')],
        hasMore: true,
        nextCursor: 'second-page',
        newestAt: 1_800_000_000,
        siteErrors: [{ siteId: 'broken', siteName: 'Broken', error: 'Offline' }]
      },
      {
        posts: [post('second')],
        hasMore: false,
        nextCursor: null,
        newestAt: null,
        siteErrors: []
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
    expect(result.siteErrors.map((error) => error.siteId)).toEqual(['broken']);
    expect(result.hasMore).toBe(false);
    expect(result.newestAt).toBe(1_800_000_000);
  });

  it('stops after three pages of read posts and leaves the rest to Show more', async () => {
    let page = 0;

    const result = await collectSubscriptionPosts({
      cursor: null,
      target: 2,
      signal: new AbortController().signal,
      fetchPage: async () => {
        page += 1;
        return {
          posts: [post(`read-${page}`)],
          hasMore: true,
          nextCursor: `page-${page + 1}`,
          newestAt: null,
          siteErrors: []
        };
      },
      keep: () => false
    });

    expect(page).toBe(3);
    expect(result.posts).toEqual([]);
    expect(result.nextCursor).toBe('page-4');
    expect(result.hasMore).toBe(true);
  });

  it('keeps the posts already read when a later page fails', async () => {
    let calls = 0;

    const result = await collectSubscriptionPosts({
      cursor: null,
      target: 5,
      signal: new AbortController().signal,
      fetchPage: async () => {
        calls += 1;
        if (calls === 2) throw new Error('Network down');
        return { posts: [post('first')], hasMore: true, nextCursor: 'second', newestAt: null, siteErrors: [] };
      },
      keep: () => true
    });

    expect(result.posts.map((entry) => entry.remoteId)).toEqual(['first']);
    expect(result.nextCursor).toBe('second');
    expect(result.hasMore).toBe(true);
    expect(result.siteErrors[0].error).toBe('Network down');
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

describe('groupFeedByDay', () => {
  const at = (createdAt: string | null) => ({ createdAt });
  const now = new Date(2026, 10, 14, 12);

  it('starts a day at each new local date and a month at each new month', () => {
    const days = groupFeedByDay(
      [
        at(new Date(2026, 10, 14, 9).toISOString()),
        at(new Date(2026, 10, 14, 1).toISOString()),
        at(new Date(2026, 10, 13, 22).toISOString()),
        at(new Date(2026, 10, 2, 8).toISOString()),
        at(new Date(2026, 9, 30, 8).toISOString())
      ],
      now
    );
    expect(days.map((day) => [day.key, day.posts.length])).toEqual([
      ['2026-11-14', 2],
      ['2026-11-13', 1],
      ['2026-11-02', 1],
      ['2026-10-30', 1]
    ]);
    expect(days.slice(0, 2).map((day) => day.dayLabel)).toEqual([
      'Today',
      'Yesterday'
    ]);
    expect(days.map((day) => day.monthLabel !== null)).toEqual([true, false, false, true]);
  });

  it('keeps an undated post in the day it arrived in', () => {
    const days = groupFeedByDay(
      [at(null), at(new Date(2026, 10, 14).toISOString()), at(null), at('not a date')],
      now
    );
    expect(days.map((day) => [day.key, day.posts.length])).toEqual([
      [null, 1],
      ['2026-11-14', 3]
    ]);
  });
});
