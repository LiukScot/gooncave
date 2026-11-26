import { expectNoFlash } from './frameFlash';
import { expect, test, type Page } from './helpers';

// A fractional display scale, as on many laptops: layers that do not line up
// leave gaps of the colour behind them.
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.25 });

const openIn = async (page: Page, mode: 'dark' | 'light', path: string) => {
  await page.goto('/app/gallery');
  await page.evaluate((m) => localStorage.setItem('gooncave:appearance', JSON.stringify({ mode: m, accent: 'blue' })), mode);
  await page.goto(path);
  // Thumbnails arriving rearrange the gallery: that is loading, not a flash.
  await page.waitForLoadState('networkidle');
};

for (const mode of ['dark', 'light'] as const) {
  test.describe(`${mode} mode`, () => {
    test('opening a Settings page and going back draws no white or black flash', async ({ page }) => {
      await openIn(page, mode, '/app/settings');
      const appearance = page.getByRole('link', { name: /appearance/i }).first();
      await expect(appearance).toBeVisible();
      await expectNoFlash(page, () => appearance.click());
      const back = page.getByRole('link', { name: /back to settings/i });
      await expect(back).toBeVisible();
      await expectNoFlash(page, () => back.click());
      await expectNoFlash(page, () => page.goBack());
    });

    test('opening a file and going back to the gallery draws no white or black flash', async ({ page }) => {
      await openIn(page, mode, '/app/gallery');
      // No upload: the test server starts with files, and other specs keep seeing the same library.
      // The picture, not the first tile: the library's order follows file times, and a video
      // first in the grid kept the test waiting until it timed out.
      const tile = page.locator('[data-test-id="file-card"][aria-label$=".png"]').first();
      await expect(tile).toBeVisible();
      await expectNoFlash(page, () => tile.click());
      await expect(page.locator('.file-detail-frame')).toBeVisible();
      await expectNoFlash(page, () => page.goBack());
      await expect(tile).toBeVisible();
    });
  });
}
