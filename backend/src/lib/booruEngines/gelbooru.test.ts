import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';

import type { BooruSiteRecord } from '../dataStore';

import { gelbooruEngine } from './gelbooru';

// Snapshot the global dispatcher so each test can restore it via t.after,
// preventing the mock from leaking into other test files when run in parallel.
const setupMockAgent = (t: TestContext): MockAgent => {
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  t.after(async () => {
    await agent.close();
    setGlobalDispatcher(previous);
  });
  return agent;
};

const baseSite = (overrides: Partial<BooruSiteRecord> = {}): BooruSiteRecord => ({
  id: 'site-1',
  userId: 'user-1',
  name: 'TestBooru',
  engine: 'gelbooru',
  baseUrl: 'https://gelbooru.com',
  username: '42',
  apiKey: 'testkey',
  isPreset: false,
  presetKey: null,
  enabled: true,
  capFavorites: true,
  capTags: true,
  capSourceMatch: true,
  capSearch: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides
});

const favHtmlPage = (postIds: number[]): string =>
  postIds
    .map((id) => `<a href="index.php?page=post&amp;s=view&amp;id=${id}">x</a>`)
    .join('\n');

const postJson = (id: number, fileUrl: string | null) =>
  JSON.stringify([{ id, file_url: fileUrl, sample_url: null, tags: 't' }]);

const mockPool = (agent: MockAgent) => agent.get('https://gelbooru.com');

test('fetchFavorites throws when credentials missing', async () => {
  const site = baseSite({ username: null, apiKey: null });
  await assert.rejects(() => gelbooruEngine.fetchFavorites!(site), /credentials missing/);
});

test('fetchFavorites scrapes HTML and resolves each post via API', async (t) => {
  const agent = setupMockAgent(t);
  // First call: HTML favorites page (returns 2 post ids)
  mockPool(agent)
    .intercept({ path: (p: string) => p.includes('page=favorites') })
    .reply(200, favHtmlPage([1, 2]));
  // Empty second HTML page (signals end of pagination)
  mockPool(agent)
    .intercept({ path: (p: string) => p.includes('page=favorites') })
    .reply(200, '');
  // API calls for each post id
  mockPool(agent)
    .intercept({ path: (p: string) => p.includes('s=post') && p.includes('id=1') })
    .reply(200, postJson(1, 'https://img.gelbooru.com/1.jpg'));
  mockPool(agent)
    .intercept({ path: (p: string) => p.includes('s=post') && p.includes('id=2') })
    .reply(200, postJson(2, 'https://img.gelbooru.com/2.jpg'));

  const result = await gelbooruEngine.fetchFavorites!(baseSite());
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].remoteId, '1');
  assert.equal(result.items[0].fileUrl, 'https://img.gelbooru.com/1.jpg');
  assert.match(result.items[0].sourceUrl, /page=post&s=view&id=1/);
  assert.equal(result.items[1].remoteId, '2');
});

test('fetchFavorites returns empty list when HTML page has no posts', async (t) => {
  const agent = setupMockAgent(t);
  mockPool(agent)
    .intercept({ path: (p: string) => p.includes('page=favorites') })
    .reply(200, '<html><body>no favorites</body></html>');

  const result = await gelbooruEngine.fetchFavorites!(baseSite());
  assert.equal(result.items.length, 0);
});

test('fetchFavorites throws when HTML page returns non-200', async (t) => {
  const agent = setupMockAgent(t);
  mockPool(agent)
    .intercept({ path: (p: string) => p.includes('page=favorites') })
    .reply(500, 'server error');

  await assert.rejects(() => gelbooruEngine.fetchFavorites!(baseSite()), /favorites page failed.*500/);
});

test('fetchFavorites throws on JSON-string auth error from post API', async (t) => {
  const agent = setupMockAgent(t);
  mockPool(agent)
    .intercept({ path: (p: string) => p.includes('page=favorites') })
    .reply(200, favHtmlPage([1]));
  mockPool(agent)
    .intercept({ path: (p: string) => p.includes('s=post') })
    .reply(200, JSON.stringify('Missing authentication. Go to api.rule34.xxx'));

  await assert.rejects(
    () => gelbooruEngine.fetchFavorites!(baseSite()),
    /favorites failed.*Missing authentication/
  );
});

test('fetchFavorites skips a post when its API call fails (non-200)', async (t) => {
  const agent = setupMockAgent(t);
  mockPool(agent)
    .intercept({ path: (p: string) => p.includes('page=favorites') })
    .reply(200, favHtmlPage([1, 2]));
  mockPool(agent)
    .intercept({ path: (p: string) => p.includes('s=post') && p.includes('id=1') })
    .reply(404, 'not found');
  mockPool(agent)
    .intercept({ path: (p: string) => p.includes('s=post') && p.includes('id=2') })
    .reply(200, postJson(2, 'https://img.gelbooru.com/2.jpg'));

  const result = await gelbooruEngine.fetchFavorites!(baseSite());
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].remoteId, '2');
});

test('fetchFavorites scrapes HTML page with site.username (user_id) in URL', async (t) => {
  const agent = setupMockAgent(t);
  let capturedPath = '';
  mockPool(agent)
    .intercept({ path: (p: string) => {
      if (p.includes('page=favorites')) { capturedPath = p; return true; }
      return false;
    } })
    .reply(200, '');

  await gelbooruEngine.fetchFavorites!(baseSite({ username: '4141023' }));
  assert.match(capturedPath, /page=favorites/);
  assert.match(capturedPath, /id=4141023/);
});

test('fetchFavorites aborts when signal fires before loop', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => gelbooruEngine.fetchFavorites!(baseSite(), { signal: controller.signal }),
    /aborted/i
  );
});

test('unfavorite rejects a redirect to the favorites view', async (t) => {
  const agent = setupMockAgent(t);
  mockPool(agent)
    .intercept({ path: (p: string) => p.includes('page=favorites') && p.includes('s=delete') && p.includes('id=123') })
    .reply(302, '', {
      headers: {
        location: '/index.php?page=favorites&s=view&id='
      }
    });

  await assert.rejects(
    () => gelbooruEngine.unfavorite!(baseSite(), '123'),
    /unfavorite redirected/
  );
});
