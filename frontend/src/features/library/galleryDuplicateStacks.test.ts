import { expect, it } from 'vitest';

import { stackGalleryFiles } from './galleryDuplicateStacks';

import type { DuplicateFile, FileItem } from '@/api';

const file = (id: string): FileItem => ({
  id,
  folderId: 'folder',
  path: `/library/${id}.jpg`,
  locationType: 'LOCAL',
  sizeBytes: 100,
  mtime: '2026-01-01T00:00:00.000Z',
  sha256: id,
  phash: null,
  mediaType: 'IMAGE',
  width: 100,
  height: 100,
  durationMs: null,
  thumbPath: null,
  thumbUrl: `/thumb/${id}`,
  voteScore: 0,
  nextVoteAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
});

const duplicate = (id: string): DuplicateFile => ({
  id,
  folderId: 'other-folder',
  path: `/other/${id}.jpg`,
  mediaType: 'IMAGE',
  sizeBytes: 100,
  width: 100,
  height: 100,
  durationMs: null,
  thumbUrl: `/thumb/${id}`
});

it('includes copies outside the loaded page and keeps the first tile fixed', () => {
  const groups = [{ key: 'image', files: [duplicate('later'), duplicate('first')] }];
  const initial = stackGalleryFiles([file('first'), file('other')], groups);
  expect(initial.map((stack) => stack.anchor.id)).toEqual(['first', 'other']);
  expect(initial[0].members.map((member) => member.id)).toEqual(['first', 'later']);

  const afterLoadMore = stackGalleryFiles(
    [file('first'), file('other'), file('later'), file('new')],
    groups
  );
  expect(afterLoadMore.map((stack) => stack.anchor.id)).toEqual([
    'first',
    'other',
    'new'
  ]);
});

it('keeps distinct local files separate without a verified duplicate group', () => {
  expect(stackGalleryFiles([file('a'), file('b')], [])).toHaveLength(2);
});

it('shows a loaded duplicate while waiting for its older copy', () => {
  const newer = { ...duplicate('newer'), mtime: '2026-09-01T00:00:00.000Z' };
  const older = { ...duplicate('older'), mtime: '2026-01-01T00:00:00.000Z' };
  const groups = [{ key: 'same', files: [newer, older] }];
  const latest = { ...file('newer'), mtime: newer.mtime };
  const old = { ...file('older'), mtime: older.mtime };
  expect(stackGalleryFiles([latest, file('other')], groups, '')
    .map((stack) => stack.anchor.id)).toEqual(['newer', 'other']);
  expect(stackGalleryFiles([latest, file('other'), old], groups, '')
    .map((stack) => stack.anchor.id)).toEqual(['other', 'older']);
});

it('keeps source metadata when loaded files replace scan summaries', () => {
  const source = { ...duplicate('first'), favoriteProviders: ['site-id'] };
  const stacks = stackGalleryFiles([file('first'), file('later')], [{
    key: 'image',
    files: [source, { ...duplicate('later'), favoriteProviders: ['other-site'] }]
  }]);
  expect(stacks[0].members.map((member) => member.favoriteProviders))
    .toEqual([['site-id'], ['other-site']]);
});
