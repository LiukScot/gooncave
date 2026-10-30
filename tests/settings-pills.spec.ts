import { expect, test } from '@playwright/test';

const PAGES = ['extra', 'blacklist', 'sync', 'file-sources', 'duplicates', 'accounts', 'trash'];

test('every on/off choice in Settings is a pill', async ({ page }) => {
  for (const name of PAGES) {
    await page.goto(`/app/settings/${name}`);
    await page.waitForLoadState('networkidle');
    const plain = await page.locator('input[type="checkbox"]:not([role="switch"])').count();
    expect(plain, `${name} has a plain checkbox`).toBe(0);
  }
  await page.goto('/app/settings/extra');
  const pill = page.getByRole('switch', { name: 'Gallery vote system' });
  const before = await pill.isChecked();
  await pill.focus();
  await page.keyboard.press('Space');
  await expect(pill).toBeChecked({ checked: !before });
  await page.keyboard.press('Space');
  await expect(pill).toBeChecked({ checked: before });
});

test('Shortcuts is in the Settings menu on a desktop', async ({ page }) => {
  await page.goto('/app/settings');
  await expect(page.getByRole('link', { name: /Shortcuts/ })).toBeVisible();
});

test.describe('iPhone', () => {
  test.use({
    hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
  });

  test('Shortcuts is not in the Settings menu', async ({ page }) => {
    await page.goto('/app/settings');
    await expect(page.getByRole('link', { name: /Appearance/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Shortcuts/ })).toHaveCount(0);
  });
});
