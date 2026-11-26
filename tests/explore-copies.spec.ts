import type { ExplorePost } from '../frontend/src/api';

import { expect, test, thumbnailablePng } from './helpers';

const PAGE_SIZE = 40;

test('a copy from another site that arrives on a later page joins the tile already shown', async ({ page }) => {
  const post = (siteId: string, remoteId: string): ExplorePost => ({
    remoteId, siteId, siteName: siteId, engine: 'e621',
    previewUrl: `https://img.fixture.invalid/${siteId}-${remoteId}.png`, sampleUrl: null, fileUrl: null,
    matchPreviewUrl: `/explore/media/file.png?siteId=${siteId}&u=${remoteId}`,
    width: 600, height: 400, score: 0, rating: null, md5: `${siteId}-${remoteId}`, createdAt: null,
    tags: [], favCount: null, uploader: null, fileExt: 'png', fileSize: null, favorited: false, voted: null,
    sourceUrl: `https://${siteId}.invalid/posts/${remoteId}`, parentId: null, hasChildren: false, poolIds: []
  });
  const firstPage = Array.from({ length: PAGE_SIZE }, (_, index) => post('first', String(index + 1)));
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: ['first', 'second'].map((id, sortOrder) => ({
    id, name: id, engine: 'e621', baseUrl: `https://${id}.invalid`,
    enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
    engineCredentialSchema: 'username_api_key', sortOrder
  })) } }));
  await page.route('**/explore/posts?*', (route) => {
    const first = new URL(route.request().url()).searchParams.get('page') === '1';
    return route.fulfill({ json: {
      posts: first ? firstPage : [post('second', '99')], siteErrors: [], sites: ['first', 'second'], hasMore: first
    } });
  });
  await page.route('https://img.fixture.invalid/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: Buffer.from(thumbnailablePng, 'base64') }));
  const asked: { posts: { key: string }[]; earlier: { key: string }[] }[] = [];
  await page.route('**/explore/copies', (route) => {
    const body = route.request().postDataJSON();
    asked.push(body);
    const late = body.posts.some((one: { key: string }) => one.key === 'second:99');
    return route.fulfill({ json: { copies: late ? [['second:99', 'first:1']] : [] } });
  });
  const original = await (await page.request.get('/settings/extra')).json();
  const stacking = await page.request.put('/settings/extra', { data: { exploreStackDuplicates: true } });
  expect(stacking.ok(), 'failed to turn on stacking').toBeTruthy();
  try {
    await page.goto('/app/explore');
    const cards = page.getByRole('button', { name: /^Open post / });
    await expect(cards).toHaveCount(PAGE_SIZE);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect.poll(() => asked.length).toBe(2);
    expect(asked[1].posts.map((one) => one.key)).toEqual(['second:99']);
    expect(asked[1].earlier).toHaveLength(PAGE_SIZE);
    await expect(page.getByRole('button', { name: /Sources: first, second\. 1 of 2\./ })).toBeVisible();
    await expect(cards).toHaveCount(PAGE_SIZE);
  } finally {
    await page.request.put('/settings/extra', { data: { exploreStackDuplicates: original.exploreStackDuplicates } });
  }
});
