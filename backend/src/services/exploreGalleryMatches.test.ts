import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';

import { test } from 'bun:test';

import {
  hashDistance,
  matchesFavoriteFingerprint
} from './exploreGalleryMatches';

test('gallery image hashes tolerate a small image variation', () => {
  assert.equal(hashDistance('0000000000000000', '0000000000000003'), 2);
});

test('gallery image hashes reject invalid and unrelated fingerprints', () => {
  assert.equal(hashDistance('not-a-hash', '0000000000000000'), Infinity);
  assert.ok(hashDistance('0000000000000000', 'ffffffffffffffff') > 2);
});

test('gallery matching requires both a close hash and the same shape', () => {
  const candidate = {
    key: 'site:post',
    url: 'https://media.test/post.jpg',
    width: 1200,
    height: 800,
    fileExt: 'jpg'
  };
  assert.equal(
    matchesFavoriteFingerprint('0000000000000000', candidate, [
      { phash: '0000000000000003', width: 600, height: 400 }
    ]),
    true
  );
  assert.equal(
    matchesFavoriteFingerprint('0000000000000000', candidate, [
      { phash: '0000000000000003', width: 800, height: 1200 }
    ]),
    false
  );
});
