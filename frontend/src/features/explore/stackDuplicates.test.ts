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

  it('extends the stacks of earlier posts and leaves new tiles after them', () => {
    const stacks = stackDuplicates([post('a', 'abc'), post('other', null)]);
    stackDuplicates([post('b', 'abc'), post('c', 'new')], stacks);
    expect(stacks.map((stack) => stack.map((item) => item.remoteId)))
      .toEqual([['a', 'b'], ['other'], ['c']]);
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

  it('stacks a post the core found to show the picture of one loaded on an earlier page', () => {
    const original = post('a', null);
    const different = post('c', null);
    const stacks = stackDuplicates([original, different]);
    const copy = post('b', null, { sameLookAs: ['a:a'] });
    expect(stackDuplicates([copy], stacks)).toEqual([[original, copy], [different]]);
  });

  it('stacks exact reuploads from different users on the same site', () => {
    const original = post('a', 'ABC', { siteId: 'same', uploader: 'first' });
    const reupload = post('b', 'abc', { siteId: 'same', uploader: 'second' });
    expect(stackDuplicates([original, reupload])).toEqual([[original, reupload]]);
  });

  it('does not make a stack from the same post returned twice', () => {
    const original = post('a', 'abc', { siteId: 'same' });
    expect(stackDuplicates([original, original])).toEqual([[original], [original]]);
  });
});
