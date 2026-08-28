// Unit tests for the explore merge and the two window helpers behind it.
// No network. No DB.
import assert from 'node:assert/strict';

import { test } from 'bun:test';

import {
  idAtAge,
  windowStartDate,
  WINDOW_SECONDS
} from '../lib/booruEngines/helpers';

import { mergeExplorePosts, type ExplorePost } from './explore';

const post = (overrides: Partial<ExplorePost>): ExplorePost => ({
  remoteId: '1',
  previewUrl: null,
  sampleUrl: null,
  fileUrl: null,
  width: null,
  height: null,
  score: null,
  rating: null,
  md5: null,
  createdAt: null,
  tags: [],
  siteId: 'site-a',
  siteName: 'Site A',
  engine: 'e621',
  sourceUrl: 'https://a.example/posts/1',
  ...overrides
});

test('mergeExplorePosts dedupes by md5 keeping first site order', () => {
  const merged = mergeExplorePosts(
    [
      [post({ remoteId: '1', md5: 'aaa', siteId: 'site-a' })],
      [
        post({ remoteId: '9', md5: 'aaa', siteId: 'site-b' }),
        post({ remoteId: '10', md5: 'bbb', siteId: 'site-b' })
      ]
    ],
    'hot'
  );
  assert.equal(merged.length, 2);
  assert.equal(merged.find((p) => p.md5 === 'aaa')?.siteId, 'site-a');
});

test('mergeExplorePosts keeps md5-less posts even when duplicated', () => {
  const merged = mergeExplorePosts(
    [[post({ remoteId: '1' })], [post({ remoteId: '1', siteId: 'site-b' })]],
    'hot'
  );
  assert.equal(merged.length, 2);
});

test('mergeExplorePosts sorts new by createdAt desc, unknown dates last', () => {
  const merged = mergeExplorePosts(
    [
      [
        post({ remoteId: '1', createdAt: '2026-01-01T00:00:00.000Z' }),
        post({ remoteId: '2', createdAt: null }),
        post({ remoteId: '3', createdAt: '2026-06-01T00:00:00.000Z' })
      ]
    ],
    'new'
  );
  assert.deepEqual(
    merged.map((p) => p.remoteId),
    ['3', '1', '2']
  );
});

test('mergeExplorePosts sorts hot and popular by score desc', () => {
  const merged = mergeExplorePosts(
    [
      [post({ remoteId: '1', score: 5 }), post({ remoteId: '2', score: null })],
      [post({ remoteId: '3', score: 42 })]
    ],
    'popular'
  );
  assert.deepEqual(
    merged.map((p) => p.remoteId),
    ['3', '1', '2']
  );
});

test('windowStartDate walks back the requested span', () => {
  const now = new Date('2026-08-28T12:00:00.000Z');
  assert.equal(windowStartDate(WINDOW_SECONDS.day, now), '2026-08-27');
  assert.equal(windowStartDate(WINDOW_SECONDS.week, now), '2026-08-21');
  assert.equal(windowStartDate(WINDOW_SECONDS.month, now), '2026-07-29');
});

test('idAtAge projects the id timeline back by the window', () => {
  // 20000 ids in 48h is 10000/day, so a one-day window starts 10000 back.
  const newestAt = 1_800_000_000;
  const id = idAtAge(
    18_583_773,
    newestAt,
    18_563_773,
    newestAt - 48 * 3600,
    WINDOW_SECONDS.day
  );
  assert.equal(id, 18_573_773);
});

test('idAtAge refuses to guess from a degenerate sample', () => {
  const at = 1_800_000_000;
  // Same instant, and ids running backwards: both mean "no usable rate".
  assert.equal(idAtAge(100, at, 90, at, 86_400), 0);
  assert.equal(idAtAge(100, at, 200, at - 3600, 86_400), 0);
});
