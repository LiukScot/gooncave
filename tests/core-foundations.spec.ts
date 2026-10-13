import { expect, test } from '@playwright/test';

import type { ExplorePost } from '../frontend/src/api';

test('opens the gallery without login and keeps a setting after reload', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/app\/gallery$/);
  await expect(page.getByRole('heading', { name: 'Gallery', exact: true })).toBeVisible();
  await page.goto('/app/settings');
  await expect(page.getByRole('button', { name: 'Logout' })).toHaveCount(0);
  await page.goto('/app/settings/extra');
  const setting = page.getByRole('checkbox', { name: 'Gallery vote system' });
  const initial = await setting.isChecked();
  const save = page.waitForResponse((response) => response.url().endsWith('/settings/extra') && response.request().method() === 'PUT');
  await setting.click();
  await expect(setting).toBeChecked({ checked: !initial });
  expect((await save).ok()).toBeTruthy();
  await page.reload();
  await expect(setting).toBeChecked({ checked: !initial });
});

test('Subscribed resumes an opened post on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.request.put('/settings/subscriptions/tags', { data: { tags: ['fixture_artist'] } });
  let bookmark: string | null = null;
  const posts: ExplorePost[] = ['7', '8'].map((id) => ({
    remoteId: id, siteId: 'fixture', siteName: 'Fixture', engine: 'moebooru',
    previewUrl: '/favicon.png', sampleUrl: '/favicon.png', fileUrl: '/favicon.png',
    width: 100, height: 100, score: null, rating: null, md5: null, createdAt: null,
    tags: [{ tag: 'fixture_artist', category: 'artist' }], favCount: null, uploader: null,
    fileExt: 'png', fileSize: null, favorited: false, voted: null,
    sourceUrl: `https://fixture.invalid/post/show/${id}`, parentId: null, hasChildren: false, poolIds: []
  }));
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [{
    id: 'fixture', name: 'Fixture', engine: 'moebooru', baseUrl: 'https://fixture.invalid',
    enabled: true, username: null, hasApiKey: false, hasSessionCookie: false,
    engineCredentialSchema: 'none', sortOrder: 0
  }] } }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: { posts: [], siteErrors: [], sites: ['fixture'] } }));
  await page.route('**/explore/subscriptions?*', (route) => route.fulfill({ json: {
    posts: bookmark && new URL(route.request().url()).searchParams.get('resume') === '1'
      ? posts.filter((post) => post.remoteId === bookmark) : posts,
    hasMore: false, nextCursor: null, ready: true
  } }));
  await page.route('**/explore/subscriptions/refresh', (route) => route.fulfill({ json: { errors: [] } }));
  await page.route('**/explore/subscriptions/bookmark', (route) => {
    bookmark = route.request().postDataJSON().remoteId;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route(/\/explore\/post(?:-tags|-text|-relations|-pools)?\?/, (route) => route.fulfill({ json: {
    post: posts[1], tags: posts[1].tags, title: null, description: null, parent: null, children: [], pools: []
  } }));
  try {
    await page.goto('/app/explore');
    await page.getByRole('button', { name: 'Subscribed', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Subscribed', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Open post 8 from Fixture', exact: false }).click();
    await expect.poll(() => bookmark).toBe('8');
    await page.goto('/app/explore');
    await page.getByRole('button', { name: 'Subscribed', exact: true }).click();
    await expect(page.locator('[data-test-id="explore-card"]')).toHaveCount(1);
    await expect(page.locator('[data-test-id="explore-card"]')).toHaveAttribute('data-read-key', 'fixture:8');
    await expect(page.getByRole('button', { name: 'Show newest posts', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  } finally {
    await page.request.put('/settings/subscriptions/tags', { data: { tags: [] } });
  }
});

test('core startup failure remains visible and can be retried', async ({ page }) => {
  await page.route('**/device', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Storage is unavailable.' }) }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Library unavailable' })).toBeVisible();
  await page.unroute('**/device');
  await page.getByRole('button', { name: 'Open library again' }).click();
  await expect(page.getByRole('heading', { name: 'Gallery', exact: true })).toBeVisible();
});

test('File sources saves a device-only key without exposing it after reload', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/settings/file-sources');
  await expect(page.getByRole('link', { name: 'Configure accounts', exact: true })).toHaveAttribute('href', '/app/settings/accounts');
  await page.getByRole('button', { name: 'Add key', exact: true }).click();
  await page.getByLabel('API key', { exact: true }).fill('fixture-source-key');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Key saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Key saved', { exact: true })).toBeVisible();
  const credentials = await page.request.get('/credentials');
  expect(await credentials.text()).not.toContain('fixture-source-key');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: 'Remove key', exact: true }).click();
  await expect(page.getByText('No key', { exact: true })).toBeVisible();
});

test('Explore offers account setup and subscriptions save searches after reload', async ({ page }) => {
  await page.goto('/app/explore');
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Configure booru accounts', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/settings\/accounts$/);
  await expect(page.getByText('Configure the sites and credentials used to browse Explore.')).toBeVisible();
  await page.goto('/app/settings/subscriptions');
  const searches = page.getByRole('textbox', { name: 'One search per row' });
  await searches.fill('fixture_artist score:>10\nfixture_search');
  const saved = page.waitForResponse((response) => response.url().endsWith('/settings/subscriptions/tags') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save searches' }).click();
  expect((await saved).ok()).toBeTruthy();
  await page.reload();
  await expect(searches).toHaveValue('fixture_artist score:>10\nfixture_search');
  await searches.fill('');
  await page.getByRole('button', { name: 'Save searches' }).click();
  await expect(page.getByRole('button', { name: 'Save searches' })).toBeDisabled();
});
