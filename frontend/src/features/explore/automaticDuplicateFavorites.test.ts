import { describe, expect, it } from 'vitest';

import {
  automaticDuplicateFavoriteTargets,
  drainAutomaticFavoriteQueue,
  galleryMatchBatches
} from './automaticDuplicateFavorites';

import type { ExplorePost } from '@/api';

const post = (
  remoteId: string,
  overrides: Partial<ExplorePost> = {}
): ExplorePost =>
  ({
    remoteId,
    siteId: remoteId,
    md5: 'same-image',
    favorited: false,
    ...overrides
  }) as ExplorePost;

describe('automaticDuplicateFavoriteTargets', () => {
  it('splits restored galleries within the backend request limit', () => {
    const items = Array.from({ length: 201 }, (_, index) => index);
    expect(galleryMatchBatches(items).map((batch) => batch.length)).toEqual([
      100,
      100,
      1
    ]);
  });

  it('selects an unfavorited supported copy of a favorited image', () => {
    const favorite = post('favorite', { favorited: true });
    const target = post('target');

    expect(
      automaticDuplicateFavoriteTargets(
        [favorite, target],
        (candidate) => candidate.favorited === true,
        () => true
      )
    ).toEqual([target]);
  });

  it('does not select unrelated, already favorited, or unsupported posts', () => {
    const favorite = post('favorite', { favorited: true });
    const alreadyFavorite = post('already', { favorited: true });
    const unsupported = post('unsupported');
    const unrelated = post('unrelated', { md5: 'other-image' });

    expect(
      automaticDuplicateFavoriteTargets(
        [favorite, alreadyFavorite, unsupported, unrelated],
        (candidate) => candidate.favorited === true,
        (candidate) => candidate.remoteId !== 'unsupported'
      )
    ).toEqual([]);
  });

  it('selects a post that matches a favorite stored only in the Gallery', () => {
    const target = post('target', {
      md5: null,
      galleryFavoriteMatch: true
    });

    expect(
      automaticDuplicateFavoriteTargets(
        [target],
        () => false,
        () => true
      )
    ).toEqual([target]);
  });

  it('drains automatic favorites one at a time and skips stale searches', async () => {
    const first = post('first');
    const stale = post('stale');
    const second = post('second');
    let active = 0;
    let maxActive = 0;
    const completed: string[] = [];

    await drainAutomaticFavoriteQueue(
      [
        { generation: 2, post: first },
        { generation: 1, post: stale },
        { generation: 2, post: second }
      ],
      () => 2,
      async (candidate) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        completed.push(candidate.remoteId);
        active -= 1;
      }
    );

    expect(completed).toEqual(['first', 'second']);
    expect(maxActive).toBe(1);
  });
});
