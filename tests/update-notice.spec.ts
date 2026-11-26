import { expect, test } from './helpers';

const RELEASES = 'https://github.com/LiukScot/gooncave/releases';

test('a newer release shows a dot on the menu and a row at the top of Settings', async ({ page }) => {
  // The test core is a development build, which never reports a newer version by itself.
  await page.route('**/update', (route) =>
    route.fulfill({ json: { current: '1.9.0', latest: 'v1.10.0', newer: true, url: RELEASES } })
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/app/settings');
  await expect(page.getByRole('button', { name: 'Open menu, a new version is out' })).toBeVisible();
  const row = page.getByRole('link', { name: /GoonCave 1\.10\.0 is out/ });
  await expect(row).toHaveAttribute('href', RELEASES);
  await expect(row).toHaveAttribute('target', '_blank');

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('navigation', { name: 'Main menu' }).getByRole('link', { name: /Settings.*new version is out/ })).toBeVisible();
});

test('the same version shows no notice', async ({ page }) => {
  await page.route('**/update', (route) =>
    route.fulfill({ json: { current: '1.10.0', latest: 'v1.10.0', newer: false, url: RELEASES } })
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/app/settings');
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await expect(page.getByRole('link', { name: /is out/ })).toHaveCount(0);
});
