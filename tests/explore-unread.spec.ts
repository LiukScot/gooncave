import type { ExplorePost } from '../frontend/src/api';

import { expect, test, thumbnailablePng } from './helpers';

const SITES = ['one', 'two', 'three', 'four'];
// The reader has seen the newest posts of every site: more than one load used to get through.
const READ_PER_SITE = 600;
const SHOWN_PER_LOAD = 40;

test('Unread only shows a full page, and the next one, when the newest posts of every site are read', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('imagesearch.unreadOnly.explore', '1'));
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: SITES.map((id, sortOrder) => ({
    id, name: id, engine: 'e621', baseUrl: `https://${id}.invalid`,
    enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
    engineCredentialSchema: 'username_api_key', sortOrder
  })) } }));
  let requests = 0;
  let deepestPage = 0;
  await page.route('**/explore/posts?*', (route) => {
    requests += 1;
    const query = new URL(route.request().url()).searchParams;
    const [siteId, limit, number] = [query.get('sites')!, Number(query.get('limit')), Number(query.get('page'))];
    deepestPage = Math.max(deepestPage, number);
    const posts = Array.from({ length: limit }, (_, index): ExplorePost => {
      const position = (number - 1) * limit + index;
      return {
        remoteId: String(position), siteId, siteName: siteId, engine: 'e621', read: position < READ_PER_SITE,
        previewUrl: 'https://img.fixture.invalid/preview.png', sampleUrl: null, fileUrl: null,
        width: 600, height: 400, score: 0, rating: null, md5: `${siteId}-${position}`, createdAt: null,
        tags: [], favCount: null, uploader: null, fileExt: 'png', fileSize: null, favorited: false, voted: null,
        sourceUrl: `https://${siteId}.invalid/posts/${position}`, parentId: null, hasChildren: false, poolIds: []
      };
    });
    return route.fulfill({ json: { posts, siteErrors: [], sites: [siteId] } });
  });
  await page.route('https://img.fixture.invalid/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: Buffer.from(thumbnailablePng, 'base64') }));

  await page.goto('/app/explore');
  const cards = page.getByRole('button', { name: /^Open post / });
  await expect(cards).toHaveCount(SHOWN_PER_LOAD);
  // Seven pages of a hundred posts get each site past its read posts.
  expect(deepestPage).toBe(7);

  const before = requests;
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(cards).toHaveCount(SHOWN_PER_LOAD * 2);
  expect(requests, 'the posts already fetched are shown before the sites are asked again').toBe(before);
});
