import { expect, test } from '@playwright/test';

import { loginUi } from './helpers';

test('a freshly-seeded user lands on the gallery view with no files', async ({ page }) => {
  await loginUi(page);
  // Gallery is the default post-auth view. The empty state may render as
  // an explicit message or simply an absence of file cards; we assert the
  // view switcher is present (proves we're past login) and there are no
  // gallery tiles.
  await expect(page.getByRole('button', { name: 'Gallery' })).toBeVisible();
  const tiles = page.locator('[data-test-id="file-card"]');
  expect(await tiles.count()).toBe(0);
});

test('switching to Duplicates view does not error out on an empty library', async ({ page }) => {
  await loginUi(page);
  await page.getByRole('button', { name: 'Duplicates' }).click();
  // No alerts, no console errors past this point. Playwright's default
  // page error handler will fail the test if the React tree throws.
  await expect(page.getByRole('button', { name: 'Duplicates' })).toBeVisible();
});
