import { expect, test } from '@playwright/test';

import { loginUi, uploadSampleImage, uploadSampleImages } from './helpers';

test('a freshly-seeded user lands on the gallery view with no files', async ({
  page
}) => {
  await loginUi(page);
  await expect(page).toHaveURL(/\/app\/gallery$/);
  await expect(page.getByRole('link', { name: 'Gallery' })).toBeVisible();
  const tiles = page.locator('[data-test-id="file-card"]');
  expect(await tiles.count()).toBe(0);
});

test('navigation roundtrip covers explore, gallery, games, and settings subpages', async ({
  page
}) => {
  await loginUi(page);

  await page.getByRole('link', { name: 'Explore' }).click();
  await expect(page).toHaveURL(/\/app\/explore$/);
  // The sort row is what identifies Explore: its search box looks like the
  // gallery's, and the results depend on which boorus the account has.
  await expect(page.getByRole('button', { name: 'Subscribed' })).toBeVisible();

  await page.getByRole('link', { name: 'Games' }).click();
  await expect(page).toHaveURL(/\/app\/games$/);
  await expect(page.getByText('Games are coming soon.')).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/app\/settings$/);

  await page.getByRole('link', { name: 'Accounts' }).click();
  await expect(page).toHaveURL(/\/app\/settings\/accounts$/);
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await expect(page.getByText('Configured sites')).toBeVisible();

  await page.getByRole('link', { name: 'Back to Settings' }).click();
  await expect(page).toHaveURL(/\/app\/settings$/);

  await page.getByRole('link', { name: 'Folders' }).click();
  await expect(page).toHaveURL(/\/app\/settings\/folders$/);
  await expect(page.getByText('Library folders')).toBeVisible();

  await page.getByRole('link', { name: 'Gallery' }).click();
  await expect(page).toHaveURL(/\/app\/gallery$/);
});

test('gallery file detail deep-link survives reload', async ({ page }) => {
  await loginUi(page);
  const uploadedName = await uploadSampleImage(page);
  await page.goto('/app/gallery');

  const tiles = page.locator('[data-test-id="file-card"]');
  await expect(tiles).toHaveCount(1);
  await tiles.first().click();

  await expect(page).toHaveURL(/\/app\/gallery\?fileId=/);
  await expect(page.getByText('File name:')).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/app\/gallery\?fileId=/);
  await expect(page.getByText('File name:')).toBeVisible();
  await expect(page.getByText(uploadedName)).toBeVisible();

  const fileId = new URL(page.url()).searchParams.get('fileId');
  expect(fileId).toBeTruthy();
  const del = await page.request.delete(`/files/${fileId}`);
  expect(del.ok(), `delete file: ${del.status()}`).toBeTruthy();
});

test('upload and duplicate scan flow works across routes', async ({ page }) => {
  await loginUi(page);
  const fileNames = [`dup-a-${Date.now()}.png`, `dup-b-${Date.now()}.png`];
  await uploadSampleImages(page, fileNames);
  await expect(page.getByText(/Uploaded 2 file/)).toBeVisible();

  await page.getByRole('link', { name: 'Gallery' }).click();
  await expect(page).toHaveURL(/\/app\/gallery$/);
  await expect(page.locator('[data-test-id="file-card"]')).toHaveCount(2);

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/app\/settings$/);
  await page.getByRole('link', { name: 'Duplicates' }).click();
  await expect(page).toHaveURL(/\/app\/settings\/duplicates$/);
  await page.getByRole('button', { name: 'Run scan' }).click();
  await expect(page.getByText(/Eligible: 2\/2/)).toBeVisible();
  await expect(page.getByText('No duplicates found.')).toBeVisible();
});

test('booru site add form submits after engine detection', async ({ page }) => {
  await loginUi(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/app\/settings$/);
  await page.getByRole('link', { name: 'Accounts' }).click();
  await expect(page).toHaveURL(/\/app\/settings\/accounts$/);
  await page.getByRole('button', { name: 'New site' }).click();

  const siteName = `Playwright ${Date.now()}`;
  await page.locator('#booru-name').fill(siteName);
  await page.locator('#booru-url').fill('e621.net');
  await expect(page.getByText(/Detected: e621/i)).toBeVisible({
    timeout: 15000
  });

  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByText(siteName)).toBeVisible();
  await expect(page.getByText('https://e621.net')).toBeVisible();
});
