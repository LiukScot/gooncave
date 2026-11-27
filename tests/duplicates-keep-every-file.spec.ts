import { expect, test } from './helpers';

// The check reads files from disk: on a device that frees them it found nothing, while the page
// still let the person preview and turn on the automation as if it worked there.
test('Matching images is grayed out with the reason on a device that does not keep every file', async ({ page }) => {
  await page.route('**/originals', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), keepAll: false } });
  });
  await page.goto('/app/settings/duplicates');

  await expect(page.locator('[data-test-id="duplicates-need-every-file"]')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Keep every file' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Keep every favorite/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Preview changes' })).toBeDisabled();
});

test('Matching images stays usable on a device that keeps every file', async ({ page }) => {
  await page.goto('/app/settings/duplicates');

  await expect(page.getByRole('radio', { name: /Keep every favorite/ })).toBeEnabled();
  await expect(page.locator('[data-test-id="duplicates-need-every-file"]')).toHaveCount(0);
});
