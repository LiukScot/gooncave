import assert from 'node:assert/strict';

import { afterEach, test } from 'bun:test';

import { disarmFetchMock, setupFetchMock } from '../../../test/helpers/fetchMock';
import type { BooruSiteRecord } from '../../db/types';

import { philomenaEngine } from './philomena';

afterEach(disarmFetchMock);

test('Derpibooru grid uses medium images and falls back to thumbnails', async () => {
  const fetchMock = setupFetchMock();
  fetchMock.intercept((url) => url.includes('/api/v1/json/search/images'), {
    status: 200,
    body: JSON.stringify({
      images: [
        { id: 1, representations: { thumb: '/thumb/1.jpg', medium: '/medium/1.jpg', large: '/large/1.jpg' } },
        { id: 2, representations: { thumb: '/thumb/2.jpg' } }
      ]
    })
  });
  const site: BooruSiteRecord = {
    id: 'derpibooru',
    userId: 'user-1',
    name: 'Derpibooru',
    engine: 'philomena',
    baseUrl: 'https://derpibooru.org',
    username: null,
    apiKey: null,
    sessionCookie: null,
    isPreset: true,
    presetKey: 'DERPIBOORU',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  };

  const result = await philomenaEngine.searchPosts!(site, {
    tags: [],
    sort: 'new',
    window: 'day',
    date: '2026-09-18',
    page: 1,
    limit: 40
  });

  assert.deepEqual(result.posts.map((post) => post.previewUrl), [
    '/medium/1.jpg',
    '/thumb/2.jpg'
  ]);
  assert.equal(result.posts[0].sampleUrl, '/large/1.jpg');
});
