import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { FileInfoList } from './DetailSections';

import type { FileItem } from '@/api';

const file = {
  id: 'f',
  path: '/library/favorite-abc-7.png',
  sizeBytes: 2_000_000,
  mtime: '2024-01-02T03:04:05.000Z',
  createdAt: '2025-06-07T08:09:10.000Z',
  mediaType: 'IMAGE',
  width: 640,
  height: 480,
  durationMs: null,
  voteScore: 3
} as FileItem;

const html = (siteInfo: Parameters<typeof FileInfoList>[0]['siteInfo']) =>
  renderToStaticMarkup(<FileInfoList file={file} siteInfo={siteInfo} voteSystemEnabled />);

it('shows when the file was added and drops the file name and the modified date', () => {
  const out = html(null);
  expect(out).toContain('Added:');
  expect(out).not.toContain('File name');
  expect(out).not.toContain('favorite-abc-7.png');
  expect(out).not.toContain('Modified');
});

it('lists what the site said and tells its score from GoonCave’s own', () => {
  const out = html({ engine: 'e621', uploader: 'artist_1', rating: 'e', score: 22, favorites: 5 });
  expect(out).toContain('Uploader:');
  expect(out).toContain('artist_1');
  expect(out).toContain('Rating:');
  expect(out).toContain('Explicit');
  expect(out).toContain('Score (site):');
  expect(out).toContain('Score (GoonCave):');
  expect(out).toContain('Favorites:');
});

it('shows no site rows for a file that came from no post', () => {
  const out = html(null);
  expect(out).not.toContain('Score (site)');
  expect(out).not.toContain('Uploader');
});
