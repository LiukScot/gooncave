import { expect, test, type Page } from '@playwright/test';

import { thumbnailablePng, uploadSampleImages } from './helpers';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });

// Toasts and the database repair notice both sit `--toast-offset-bottom` above the bottom edge.
// A fixed probe with the same offset shows where that is without needing a toast to appear.
const toastGap = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:var(--toast-offset-bottom);height:1px;width:1px';
    document.body.append(probe);
    const gap = window.innerHeight - probe.getBoundingClientRect().bottom;
    probe.remove();
    return gap;
  });

const lensHeight = (page: Page) =>
  page.evaluate(() => {
    const lens = document.querySelector('.search-lens')!.getBoundingClientRect();
    return window.innerHeight - lens.top;
  });

for (const path of ['/app/gallery', '/app/explore']) {
  test(`on ${path} the toast clears the lens by a small margin`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('.search-lens')).toBeVisible();
    const gap = await toastGap(page);
    const lens = await lensHeight(page);
    expect(gap).toBeGreaterThanOrEqual(lens);
    expect(gap - lens).toBeLessThan(24);
  });
}

test('on the file page, where the lens is hidden, the toast sits just above the action buttons', async ({ page }) => {
  await page.goto('/app/gallery');
  await page.locator('.gallery-thumb').first().click();
  await expect(page.locator('.file-detail-panel-current .file-detail-tags')).toBeVisible();
  const actions = await page.locator('.phone-actions').evaluate((element) => window.innerHeight - element.getBoundingClientRect().top);
  const gap = await toastGap(page);
  expect(gap).toBeGreaterThanOrEqual(actions);
  expect(gap - actions).toBeLessThan(24);
});

test('in a window narrow enough to reach the corner buttons, the toast stays above them', async ({ page }) => {
  await page.goto('/app/gallery');
  await page.locator('.gallery-thumb').first().click();
  await expect(page.locator('.file-detail-panel-current .file-detail-tags')).toBeVisible();
  await page.setViewportSize({ width: 800, height: 600 });
  await expect(page.locator('.phone-actions')).toBeVisible();
  const actions = await page.locator('.phone-actions').evaluate((element) => window.innerHeight - element.getBoundingClientRect().top);
  expect(await toastGap(page)).toBeGreaterThanOrEqual(actions);
});

test('the vote clock sits with the Undo message above the buttons, then both leave until the next vote', async ({ page }) => {
  const name = `vote-clock-${Date.now()}.png`;
  await page.addInitScript(() =>
    localStorage.setItem('gooncave:appearance', JSON.stringify({ quickActions: { file: 'vote' } }))
  );
  await page.goto('/app/gallery');
  await uploadSampleImages(page, [name], {
    base64: Buffer.concat([Buffer.from(thumbnailablePng, 'base64'), Buffer.from(name)]).toString('base64')
  });
  const settings = await (await page.request.get('/settings/extra')).json();
  await page.route('**/settings/extra', (route) => route.fulfill({ json: { ...settings, voteSystemEnabled: true } }));
  await page.reload();
  await page.locator('[data-test-id="file-card"]').and(page.locator(`[aria-label*="${name}"]`)).click({ position: { x: 8, y: 8 } });

  const clock = page.locator('.phone-actions .file-detail-overlay-cooldown');
  const undo = page.locator('.file-detail-vote-undo');
  const voteUp = page.getByRole('button', { name: 'Vote up', exact: true });
  await voteUp.tap();
  await expect(clock).toBeVisible();
  await undo.getByRole('button', { name: 'Undo' }).tap();
  await expect(clock).toHaveCount(0);
  await expect(voteUp).toBeVisible();

  await voteUp.tap();
  await expect(clock).toBeVisible();
  const message = (await undo.boundingBox())!;
  const buttons = (await page.locator('.phone-actions').boundingBox())!;
  expect(message.y + message.height).toBeLessThanOrEqual(buttons.y);
  expect(message.y + message.height).toBeLessThanOrEqual(page.viewportSize()!.height);

  await expect(undo).toHaveCount(0, { timeout: 10_000 });
  await expect(clock).toHaveCount(0);
  await expect(voteUp).toHaveCount(0);
  await expect(page.locator('[data-test-id="vote-cooldown-info"]').first()).toContainText('votable again in 24h');

  const { files } = (await (await page.request.get('/files?limit=500')).json()) as { files: { id: string; path: string }[] };
  const uploaded = files.find((file) => file.path.endsWith(name));
  if (uploaded) await page.request.delete(`/files/${uploaded.id}`);
});

const site = { id: 'rule', name: 'Rule34', engine: 'gelbooru', baseUrl: 'https://rule34.example', username: null, hasApiKey: false,
  hasSessionCookie: false, isPreset: false, presetKey: null, enabled: true, siteAutoSyncMidnight: false, siteReverseSyncEnabled: false,
  siteAutoFavEnabled: false, sortOrder: 0, createdAt: '', updatedAt: '', engineCredentialSchema: { fields: [] }, engineSupportsSessionCookie: false, browserSignIn: null };

test('a failing site on Explore is a toast with Retry search, not a row above the grid', async ({ page }) => {
  await page.route('**/booru-sites', (r) => r.fulfill({ json: { sites: [site] } }));
  let searches = 0;
  await page.route('**/explore/posts*', (r) => { searches += 1; return r.fulfill({ json: { posts: [], sites: ['rule'], siteErrors: [{ siteId: 'rule', siteName: 'Rule34', error: 'The site returned an unexpected post list.' }] } }); });
  await page.goto('/app/explore');
  const toast = page.locator('[data-sonner-toast]');
  await expect(toast).toContainText('Rule34: The site returned an unexpected post list.');
  await expect(toast.getByRole('button', { name: 'Retry search' })).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Check accounts' })).toBeVisible();
  await expect(page.locator('.explore-site-error')).toHaveCount(0);
  const before = searches;
  await toast.getByRole('button', { name: 'Retry search' }).click();
  await expect.poll(() => searches).toBeGreaterThan(before);
});

test('a site error on a phone keeps its sentence wide, with the buttons under it and above the corner buttons', async ({ page }) => {
  await page.route('**/booru-sites', (r) => r.fulfill({ json: { sites: [site] } }));
  await page.route('**/explore/posts*', (r) => r.fulfill({ json: { posts: [], sites: ['rule'], siteErrors: [
    { siteId: 'rule', siteName: 'Rule34', error: 'The site is offline or under maintenance. Try again later.' }
  ] } }));
  await page.goto('/app/explore');
  const toast = page.locator('[data-sonner-toast]');
  await expect(toast).toContainText('Rule34: The site is offline');
  // Sonner slides the toast in; measure where it stops.
  let previous = -1;
  await expect.poll(async () => {
    const top = (await toast.boundingBox())!.y;
    const settled = top === previous;
    previous = top;
    return settled;
  }).toBe(true);
  const box = (await toast.boundingBox())!;
  const title = (await toast.locator('[data-title]').boundingBox())!;
  // Beside the buttons the sentence had a third of the toast and ran to six lines.
  expect(title.width).toBeGreaterThan(box.width * 0.7);
  for (const name of ['Retry search', 'Check accounts']) {
    const button = (await toast.getByRole('button', { name }).boundingBox())!;
    expect(button.y).toBeGreaterThanOrEqual(title.y + title.height);
  }
  const lens = (await page.locator('.search-lens').boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(lens.y);
});

test('a site that is offline offers Retry search but not Check accounts', async ({ page }) => {
  await page.route('**/booru-sites', (r) => r.fulfill({ json: { sites: [site] } }));
  await page.route('**/explore/posts*', (r) => r.fulfill({ json: { posts: [], sites: ['rule'], siteErrors: [
    { siteId: 'rule', siteName: 'Rule34', error: 'The site is offline or under maintenance. Try again later.', code: 'SITE_OFFLINE' }
  ] } }));
  await page.goto('/app/explore');
  const toast = page.locator('[data-sonner-toast]');
  await expect(toast.getByRole('button', { name: 'Retry search' })).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Check accounts' })).toHaveCount(0);
});
