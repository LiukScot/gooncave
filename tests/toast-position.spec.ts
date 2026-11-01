import { expect, test, type Page } from '@playwright/test';

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

test('a failing site on Explore is a toast with Retry search, not a row above the grid', async ({ page }) => {
  const site = { id: 'rule', name: 'Rule34', engine: 'gelbooru', baseUrl: 'https://rule34.example', username: null, hasApiKey: false,
    hasSessionCookie: false, isPreset: false, presetKey: null, enabled: true, siteAutoSyncMidnight: false, siteReverseSyncEnabled: false,
    siteAutoFavEnabled: false, sortOrder: 0, createdAt: '', updatedAt: '', engineCredentialSchema: { fields: [] }, engineSupportsSessionCookie: false, browserSignIn: null };
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
