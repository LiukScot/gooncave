import { expect, test } from '@playwright/test';

test('opens an empty gallery without login and keeps a setting after reload', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/app\/gallery$/);
  await expect(page.getByRole('heading', { name: 'Gallery', exact: true })).toBeVisible();
  await expect(page.getByText('0 items', { exact: true })).toBeVisible();
  await expect(page.getByText('Folder import is not available', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Open settings', exact: true }).click();
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

test('core startup failure remains visible and can be retried', async ({ page }) => {
  await page.route('**/device', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Storage is unavailable.' }) }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Library unavailable' })).toBeVisible();
  await page.unroute('**/device');
  await page.getByRole('button', { name: 'Open library again' }).click();
  await expect(page.getByRole('heading', { name: 'Gallery', exact: true })).toBeVisible();
});

test('unfinished features explain availability and keep settings reachable', async ({ page }) => {
  await page.goto('/app/explore');
  await expect(page.getByRole('status')).toContainText('Explore is not available in this development build.');
  await page.getByRole('link', { name: 'Open settings', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/settings$/);
});
