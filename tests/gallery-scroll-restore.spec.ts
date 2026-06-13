import { expect, test } from '@playwright/test';

import { loginUi, uploadSampleImages } from './helpers';

// Allow a few px of drift from lazy-loaded thumbnails settling their height
// after the gallery remounts; the restore should still land on the same row.
const SCROLL_TOLERANCE_PX = 150;

// Regression: opening a file deep in the gallery, navigating prev/next, then
// returning (Esc or back button) used to scroll back to the top instead of
// restoring the previous gallery position.
test('gallery restores scroll position after opening, navigating, and closing a file', async ({
  page
}) => {
  await loginUi(page);
  const fileNames = Array.from(
    { length: 40 },
    (_, i) => `scroll-${Date.now()}-${i}.png`
  );
  await uploadSampleImages(page, fileNames);

  await page.goto('/app/gallery');
  const tiles = page.locator('[data-test-id="file-card"]');
  await expect(tiles).toHaveCount(40);

  // Bring a deep tile into view so the window is scrolled away from the top.
  const deepTile = tiles.nth(32);
  await deepTile.scrollIntoViewIfNeeded();
  const baseline = await page.evaluate(() => window.scrollY);
  expect(baseline, 'gallery must be scrollable for this test').toBeGreaterThan(
    0
  );

  await deepTile.click();
  await expect(page).toHaveURL(/\/app\/gallery\?fileId=/);
  await expect(page.getByText('File name:').first()).toBeVisible();

  // Navigate within the detail view — this is what used to reset the saved
  // scroll position to 0.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');

  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/app\/gallery$/);
  await expect(tiles.first()).toBeVisible();

  const restored = await page.evaluate(() => window.scrollY);
  expect(Math.abs(restored - baseline)).toBeLessThan(SCROLL_TOLERANCE_PX);
});
