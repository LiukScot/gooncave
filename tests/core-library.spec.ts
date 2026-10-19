import { expect, test } from '@playwright/test';

import type { ExplorePost } from '../frontend/src/api';

import { thumbnailablePng, uploadSampleImages } from './helpers';

const card = (page: import('@playwright/test').Page, name: string) =>
  page.locator(`[data-test-id="file-card"][aria-label*="${name}"]`);

test('browses the library folder, votes a file and deletes another', async ({ page }) => {
  // Browsing local files must not start remote refresh work.
  const booruCalls: string[] = [];
  page.on('request', (request) => {
    if (/\/tags\/refresh|\/explore\/subscriptions\/refresh/.test(request.url())) booruCalls.push(request.url());
  });
  const original = await (await page.request.get('/settings/extra')).json();
  const vote = await page.request.put('/settings/extra', { data: { voteSystemEnabled: true } });
  expect(vote.ok(), 'failed to enable votes').toBeTruthy();
  try {
    // The playwright config put these two files in the library folder before the core started.
    await page.goto('/app/gallery');
    await expect(card(page, 'landscape.png')).toBeVisible();
    await expect(card(page, 'clip.mp4')).toBeVisible();
    await expect(card(page, 'landscape.png').locator('img')).toHaveAttribute('src', /\/thumbnails\//);
    await expect(page.getByText('Duplicate stacks unavailable', { exact: false })).toHaveCount(0);

    const uploaded = `portrait-${Date.now()}.png`;
    await uploadSampleImages(page, [uploaded], { base64: thumbnailablePng });
    await page.goto('/app/settings');
    await expect(page.getByRole('link', { name: 'Folders', exact: true })).toHaveCount(0);
    await page.goto('/app/gallery');
    await card(page, uploaded).click();
    await expect(page).toHaveURL(/fileId=/);
    await page.getByRole('button', { name: 'File info' }).click();
    const votePosted = page.waitForResponse((res) => res.url().includes('/vote') && res.request().method() === 'POST');
    await page.getByRole('button', { name: 'Vote up' }).click();
    await page.getByRole('button', { name: 'Back to gallery' }).click();
    expect((await votePosted).ok()).toBeTruthy();
    await page.reload();
    const galleryVote = card(page, uploaded).locator('..').getByRole('button', { name: /Votable again in .*; score 1/ });
    await expect(galleryVote).toHaveText('1');

    // The centre of a video tile is its inline play button; the rest of the tile opens the file.
    await card(page, 'clip.mp4').click({ position: { x: 8, y: 8 } });
    await expect(page).toHaveURL(/fileId=/);
    await expect(page.locator('.file-detail-panel-current video')).toBeVisible();
    const deleted = page.waitForResponse((res) => res.request().method() === 'DELETE' && /\/files\/[^/]+$/.test(res.url()));
    await page.locator('.file-detail-panel-current .file-detail-delete-button').click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    expect((await deleted).ok()).toBeTruthy();
    await page.goto('/app/gallery');
    await expect(card(page, uploaded)).toBeVisible();
    await expect(card(page, 'clip.mp4')).toHaveCount(0);
    await expect(page.getByText('Could not update the tags')).toHaveCount(0);
    expect(booruCalls).toEqual([]);
  } finally {
    await page.request.put('/settings/extra', { data: original });
  }
});

test('a file opened from the gallery stays open after a reload', async ({ page }) => {
  await page.goto('/app/gallery');
  await card(page, 'landscape.png').click();
  await expect(page).toHaveURL(/\/app\/gallery\?fileId=/);
  await page.reload();
  await expect(page).toHaveURL(/\/app\/gallery\?fileId=/);
  // The file's name sits in File info, which opens folded.
  await page.getByRole('button', { name: 'File info' }).click();
  await expect(page.locator('.file-detail-panel-current').getByText('landscape.png')).toBeVisible();
});

for (const view of ['gallery', 'explore'] as const) {
  test(`${view} keeps controls visible for three seconds after hovering a pool indicator`, async ({ page }) => {
    await page.clock.install();
    const pools = [{
      poolId: 'fixture-pool', siteId: 'fixture', siteName: 'Fixture', name: 'Fixture pool',
      position: 1, postCount: 2, prevId: null, nextId: '2'
    }];
    if (view === 'gallery') {
      await page.route('**/files/*/pools', (route) => route.fulfill({ json: { pools } }));
      await page.goto('/app/gallery');
      await card(page, 'landscape.png').click();
    } else {
      const post: ExplorePost = {
        remoteId: '1', siteId: 'fixture', siteName: 'Fixture', engine: 'e621',
        previewUrl: '/favicon.png', sampleUrl: null, fileUrl: '/favicon.png',
        width: 640, height: 480, score: 0, rating: null, md5: null, createdAt: null,
        tags: [{ tag: 'fixture_artist', category: 'artist' }], favCount: null, uploader: null,
        fileExt: 'png', fileSize: null, favorited: false, voted: null,
        sourceUrl: 'https://fixture.invalid/posts/1', parentId: null, hasChildren: false,
        poolIds: ['fixture-pool']
      };
      await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [{
        id: 'fixture', name: 'Fixture', engine: 'e621', baseUrl: 'https://fixture.invalid',
        enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
        engineCredentialSchema: 'username_api_key', sortOrder: 0
      }] } }));
      await page.route('**/explore/posts?*', (route) => route.fulfill({ json: { posts: [post], siteErrors: [], sites: ['fixture'] } }));
      await page.route(/\/explore\/post(?:-tags|-text|-relations|-pools)?\?/, (route) => route.fulfill({ json: {
        post, tags: post.tags, title: null, description: null, parent: null, children: [], pools
      } }));
      await page.goto('/app/explore');
      await page.getByRole('button', { name: 'Open post 1 from Fixture', exact: false }).click();
    }
    const wrap = page.locator('.file-detail-panel-current .file-detail-media-wrap');
    const button = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
    const indicator = page.getByRole('link', { name: /Fixture pool/ });
    await expect(indicator).toBeVisible();
    await wrap.hover();
    await page.clock.fastForward(4_000);
    await expect(button).toHaveCSS('opacity', '1');
    await indicator.hover();
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.fastForward(2_500);
    await expect(button).toHaveCSS('opacity', '1');
    await page.getByRole('button', { name: 'File info', exact: true }).hover();
    await page.clock.fastForward(2_500);
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.fastForward(750);
    await expect(button).toHaveCSS('opacity', '0');
  });
}
