import { expect, test } from '@playwright/test';

import { loginUi, uploadSampleImage } from './helpers';

test('a freshly-seeded user lands on the gallery view with no files', async ({ page }) => {
  await loginUi(page);
  await expect(page).toHaveURL(/\/app\/gallery$/);
  await expect(page.getByRole('link', { name: 'Gallery' })).toBeVisible();
  const tiles = page.locator('[data-test-id="file-card"]');
  expect(await tiles.count()).toBe(0);
});

test('switching to Duplicates view does not error out on an empty library', async ({ page }) => {
  await loginUi(page);
  await page.getByRole('link', { name: 'Duplicates' }).click();
  // No alerts, no console errors past this point. Playwright's default
  // page error handler will fail the test if the React tree throws.
  await expect(page).toHaveURL(/\/app\/duplicates$/);
  await expect(page.getByRole('link', { name: 'Duplicates' })).toBeVisible();
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
