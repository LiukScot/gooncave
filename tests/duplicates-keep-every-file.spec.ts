import { expect, test } from './helpers';

// The scan reads files from disk, so on a device that frees them it skips the copies in the
// cloud; the page says so and still lets the person choose the option for the whole library.
test('Matching images says it compares only kept files on a device that does not keep every file', async ({ page }) => {
  await page.route('**/originals', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), keepAll: false } });
  });
  await page.goto('/app/settings/duplicates');

  await expect(page.locator('[data-test-id="duplicates-need-every-file"]')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Keep every file' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Keep every favorite/ })).toBeEnabled();
});

test('Matching images shows no notice on a device that keeps every file', async ({ page }) => {
  await page.goto('/app/settings/duplicates');

  await expect(page.getByRole('radio', { name: /Keep every favorite/ })).toBeEnabled();
  await expect(page.locator('[data-test-id="duplicates-need-every-file"]')).toHaveCount(0);
});
