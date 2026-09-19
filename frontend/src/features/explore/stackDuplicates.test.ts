import { describe, expect, it } from 'vitest';

import { stackDuplicates } from './stackDuplicates';

import type { ExplorePost } from '@/api';

const post = (
  remoteId: string,
  md5: string | null,
  overrides: Partial<ExplorePost> = {}
) => ({
  remoteId,
  md5,
  siteId: remoteId,
  sourceUrl: `https://e621.net/posts/${remoteId}`,
  ...overrides
} as ExplorePost);

describe('stackDuplicates', () => {
  it('groups same-page copies without moving the first tile', () => {
    const posts = [post('a', 'ABC'), post('other', null), post('b', 'abc')];
    expect(stackDuplicates(posts).map((stack) => stack.map((item) => item.remoteId)))
      .toEqual([['a', 'b'], ['other']]);
  });

  it('adds a later matching copy to the earlier tile', () => {
    const firstPage = [post('a', 'abc'), post('other', null)];
    const laterPage = [post('b', 'abc')];
    expect(stackDuplicates(firstPage).map((stack) => stack[0].remoteId))
      .toEqual(['a', 'other']);
    expect(stackDuplicates([...firstPage, ...laterPage]).map((stack) => stack.map((item) => item.remoteId)))
      .toEqual([['a', 'b'], ['other']]);
  });

  it('uses a credited FurAffinity post even without its MD5', () => {
    const fa = post('66388548', null, {
      sourceUrl: 'https://www.furaffinity.net/view/66388548/'
    });
    const e621 = post('6712617', 'abc', {
      sourceUrls: ['https://sfw.furaffinity.net/full/66388548/?foo=bar']
    });
    expect(stackDuplicates([fa, e621])).toEqual([[fa, e621]]);
  });

  it('accepts only very close visual copies with compatible dimensions', () => {
    const original = post('a', null, {
      width: 1200, height: 800, visualSignature: Array(768).fill(100)
    });
    const copy = post('b', null, {
      width: 600, height: 400, visualSignature: Array(768).fill(105)
    });
    const different = post('c', null, {
      width: 600, height: 400, visualSignature: Array(768).fill(145)
    });
    expect(stackDuplicates([original, copy, different])).toEqual([
      [original, copy], [different]
    ]);
  });

  it('stacks exact reuploads from different users on the same site', () => {
    const original = post('a', 'ABC', { siteId: 'same', uploader: 'first' });
    const reupload = post('b', 'abc', { siteId: 'same', uploader: 'second' });
    expect(stackDuplicates([original, reupload])).toEqual([[original, reupload]]);
  });

  it('stacks a recompressed same-site copy but keeps a different image separate', () => {
    const original = post('a', 'first-hash', {
      siteId: 'same', uploader: 'first', width: 1200, height: 800,
      visualSignature: Array(768).fill(100)
    });
    const recompressed = post('b', 'second-hash', {
      siteId: 'same', uploader: 'second', width: 600, height: 400,
      visualSignature: Array(768).fill(103)
    });
    const different = post('c', 'third-hash', {
      siteId: 'same', uploader: 'third', width: 600, height: 400,
      visualSignature: Array(768).fill(145)
    });
    expect(stackDuplicates([original, recompressed, different])).toEqual([
      [original, recompressed], [different]
    ]);
  });

  it('does not make a stack from the same post returned twice', () => {
    const original = post('a', 'abc', { siteId: 'same' });
    expect(stackDuplicates([original, original])).toEqual([[original], [original]]);
  });

  it('does not use visual similarity alone for two uploads by the same user', () => {
    const first = post('a', 'first-hash', {
      siteId: 'same', uploader: 'artist', width: 100, height: 100,
      visualSignature: Array(768).fill(100)
    });
    const second = post('b', 'second-hash', {
      siteId: 'same', uploader: 'Artist', width: 100, height: 100,
      visualSignature: Array(768).fill(100)
    });
    expect(stackDuplicates([first, second])).toEqual([[first], [second]]);
  });
});
