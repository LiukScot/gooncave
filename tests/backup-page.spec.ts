import { expect, test } from '@playwright/test';

test('Backup & sync shows its actions as icons with a short label and no old-server import', async ({ page }) => {
  await page.goto('/app/settings/sync');
  await expect(page.getByRole('button', { name: 'Back up' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible();
  await expect(page.getByText(/old (GoonCave )?server/i)).toHaveCount(0);
  // the explanations are behind help buttons, not on the page
  await expect(page.getByText(/holds no booru passwords/)).toHaveCount(0);
  await expect(page.getByRole('img', { name: /nothing on this device is deleted/ })).toBeVisible();
  expect((await page.request.post('/backup/old-database')).ok()).toBe(false);
});
