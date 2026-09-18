import assert from 'node:assert/strict';

import { afterEach, test } from 'bun:test';

import { disarmFetchMock, setupFetchMock } from '../../../test/helpers/fetchMock';
import type { BooruSiteRecord } from '../../db/types';

import { danbooruEngine } from './danbooru';
import { e621Engine } from './e621';
import { gelbooruEngine } from './gelbooru';
import { moebooruEngine } from './moebooru';
import { philomenaEngine } from './philomena';
import { sankakuEngine } from './sankaku';
import { szurubooruEngine } from './szurubooru';
import type { BooruEngine, PopularWindow } from './types';

afterEach(disarmFetchMock);

const site = (engine: BooruSiteRecord['engine']): BooruSiteRecord => ({
  id: 'site-1',
  userId: 'user-1',
  name: 'test',
  engine,
  baseUrl: 'https://example.com',
  username: null,
  apiKey: null,
  sessionCookie: null,
  isPreset: false,
  presetKey: null,
  enabled: true,
  siteAutoSyncMidnight: false,
  siteReverseSyncEnabled: false,
  siteAutoFavEnabled: false,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
});

const cases = [
  { engine: e621Engine, queryKey: 'tags', rank: 'order:score', date: 'date:2028-01-01..2028-12-31', body: '{"posts":[]}' },
  { engine: danbooruEngine, queryKey: 'tags', rank: 'order:score', date: 'date:2028-01-01..2028-12-31', body: '[]' },
  { engine: sankakuEngine, queryKey: 'tags', rank: 'order:popular', date: 'date:2028-01-01..2028-12-31', body: '[]' },
  { engine: philomenaEngine, queryKey: 'q', rank: '', date: 'created_at.gte:2028-01-01 AND created_at.lte:2028-12-31', body: '{"images":[]}' },
  { engine: moebooruEngine, queryKey: 'tags', rank: 'order:score', date: 'date:2028-01-01..2028-12-31', body: '[]' },
  { engine: szurubooruEngine, queryKey: 'query', rank: 'sort:score', date: 'creation-time:2028-01-01..2028-12-31', body: '{"results":[]}' }
] satisfies { engine: BooruEngine; queryKey: string; rank: string; date: string; body: string }[];

for (const { engine, queryKey, rank, date, body } of cases) {
  for (const window of ['year', 'all'] as PopularWindow[]) {
    test(`${engine.type} Score ${window} sends ${window === 'all' ? 'no date' : 'the calendar year'}`, async () => {
      let requestUrl = '';
      setupFetchMock().intercept((url) => {
        requestUrl = url;
        return true;
      }, { status: 200, body });

      await engine.searchPosts!(site(engine.type), {
        tags: ['subject'], sort: 'popular', window, date: '2028-02-29', page: 1, limit: 40
      });

      const query = new URL(requestUrl).searchParams.get(queryKey) ?? '';
      assert.ok(query.includes('subject'));
      if (rank) assert.ok(query.includes(rank), query);
      if (window === 'year') assert.ok(query.includes(date), query);
      else assert.ok(!/date:|created_at\.|creation-time:/.test(query), query);
    });
  }
}

test('e621 search carries credited source links into Explore posts', async () => {
  setupFetchMock().intercept(() => true, {
    status: 200,
    body: JSON.stringify({ posts: [{
      id: 123,
      sources: ['https://www.furaffinity.net/view/456/'],
      file: { md5: 'abc', width: 1200, height: 800 },
      preview: { url: 'https://cdn.test/123.jpg' }
    }] })
  });

  const { posts } = await e621Engine.searchPosts!(site('e621'), {
    tags: [], sort: 'new', window: 'all', date: '2028-02-29', page: 1, limit: 40
  });
  assert.deepEqual(posts[0]?.sourceUrls, ['https://www.furaffinity.net/view/456/']);
});

test('gelbooru Score all time skips id sampling and date bounds', async () => {
  const urls: string[] = [];
  setupFetchMock().intercept((url) => {
    urls.push(url);
    return true;
  }, { status: 200, body: '{"post":[]}' });

  await gelbooruEngine.searchPosts!(site('gelbooru'), {
    tags: ['subject'], sort: 'popular', window: 'all', date: '2028-02-29', page: 1, limit: 40
  });

  assert.equal(urls.length, 1);
  const tags = new URL(urls[0]).searchParams.get('tags') ?? '';
  assert.ok(tags.includes('sort:score'), tags);
  assert.ok(!tags.includes('id:'), tags);
});

test('gelbooru Score year translates both calendar bounds into id filters', async () => {
  const urls: string[] = [];
  const fm = setupFetchMock();
  const changed = Math.floor(Date.now() / 1000);
  fm.intercept((url) => {
    urls.push(url);
    return true;
  }, { status: 200, body: JSON.stringify([{ id: 20_000_000, change: changed }]) });
  fm.intercept((url) => {
    urls.push(url);
    return true;
  }, { status: 200, body: JSON.stringify([{ id: 19_980_000, change: changed - 2_000_000 }]) });
  fm.intercept((url) => {
    urls.push(url);
    return true;
  }, { status: 200, body: '{"post":[]}' });

  await gelbooruEngine.searchPosts!(site('gelbooru'), {
    tags: ['subject'], sort: 'popular', window: 'year', date: '2025-06-15', page: 1, limit: 40
  });

  assert.equal(urls.length, 3);
  const tags = new URL(urls[2]).searchParams.get('tags') ?? '';
  assert.match(tags, /id:>\d+/);
  assert.match(tags, /id:<\d+/);
});
