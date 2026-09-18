import { expect, it } from 'vitest';

import { gallerySourceIcons } from './gallerySourceIcons';

import type { BooruSite, DuplicateFile } from '@/api';

const site = (id: string, name: string, baseUrl: string) =>
  ({ id, name, baseUrl, presetKey: null }) as BooruSite;

const file: DuplicateFile = {
  id: 'one', folderId: 'folder', path: '/library/one.jpg', mediaType: 'IMAGE',
  sizeBytes: 10, width: 100, height: 100, durationMs: null, thumbUrl: null
};

it('shows every matched site and the favorited site once, without a local badge', () => {
  const icons = gallerySourceIcons([{
    ...file,
    favoriteProviders: ['danbooru-id'],
    providers: {
      SAUCENAO: {
        id: 'run', fileId: file.id, provider: 'SAUCENAO', status: 'COMPLETED', cachedHit: false,
        score: 96, sourceUrl: null, thumbUrl: null, createdAt: '', completedAt: '', error: null,
        results: [
          { sourceUrl: 'https://danbooru.donmai.us/posts/12', sourceName: 'Danbooru', score: 96, thumbUrl: null },
          { sourceUrl: 'https://e621.net/posts/34', sourceName: 'e621', score: 94, thumbUrl: null },
          { sourceUrl: 'https://bsky.app/profile/example/post/1', sourceName: 'Bluesky', score: 93, thumbUrl: null },
          { sourceUrl: 'https://low.example/post/4', sourceName: 'Low', score: 50, thumbUrl: null }
        ]
      }
    }
  }], [site('danbooru-id', 'Danbooru', 'https://danbooru.donmai.us')]);
  expect(icons.map((icon) => icon.label)).toEqual(['Danbooru', 'e621.net', 'bsky.app']);
  expect(icons[0].iconUrl).toBe('https://danbooru.donmai.us/favicon.ico');
  expect(icons[2].iconUrl).toBe('https://web-cdn.bsky.app/static/favicon-32x32.png');
});

it('uses only the local image badge when no source was found', () => {
  expect(gallerySourceIcons([file], [])).toEqual([
    { key: 'local', label: 'Local copy', iconUrl: null }
  ]);
});

it('does not claim a favorited file is source-free when its site was removed', () => {
  expect(gallerySourceIcons([{ ...file, favoriteProviders: ['removed-site'] }], []))
    .toEqual([{ key: 'provider:removed-site', label: 'Unknown site', iconUrl: null }]);
});

it('combines sites from loaded and off-page copies without a local badge', () => {
  const icons = gallerySourceIcons([
    { ...file, favoriteProviders: ['danbooru-id'] },
    { ...file, id: 'off-page', favoriteProviders: ['rule34-id'] }
  ], [
    site('danbooru-id', 'Danbooru', 'https://danbooru.donmai.us'),
    site('rule34-id', 'Rule34', 'https://rule34.xxx')
  ]);
  expect(icons.map((icon) => icon.label)).toEqual(['Danbooru', 'Rule34']);
});
