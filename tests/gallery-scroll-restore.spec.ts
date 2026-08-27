import { expect, test } from '@playwright/test';

import { loginUi, uploadSampleImages } from './helpers';

// Allow a few px of drift from lazy-loaded thumbnails settling their height
// after the gallery remounts; the restore should still land on the same row.
const SCROLL_TOLERANCE_PX = 150;

// Enough tiles to make the gallery scroll, but under the file-delete rate
// limit (30/min) so the teardown can remove them all in one window.
const UPLOAD_COUNT = 24;

// A narrow, short viewport forces several rows so the gallery scrolls
// regardless of the CI default window size.
test.use({ viewport: { width: 640, height: 600 } });

// Tests share one backend + DB (workers: 1), so the bulk upload below must not
// leak into sibling specs that assume a near-empty library.
let uploadedNames: string[] = [];

test.afterEach(async ({ page }) => {
  if (uploadedNames.length === 0) return;
  const res = await page.request.get('/files?limit=500');
  expect(res.ok(), 'failed to list files during teardown').toBeTruthy();
  const { files } = (await res.json()) as {
    files: { id: string; path: string }[];
  };
  const mine = new Set(uploadedNames);
  const deletions = await Promise.all(
    files
      .filter((file) => mine.has(file.path.split('/').pop() ?? ''))
      .map((file) => page.request.delete(`/files/${file.id}`))
  );
  for (const del of deletions) {
    expect(del.ok(), 'failed to delete uploaded test file').toBeTruthy();
  }
  uploadedNames = [];
});

// Regression: opening a file deep in the gallery, navigating prev/next, then
// returning (Esc or back button) used to scroll back to the top instead of
// restoring the previous gallery position.
test('gallery restores scroll position after opening, navigating, and closing a file', async ({
  page
}) => {
  await loginUi(page);
  uploadedNames = Array.from(
    { length: UPLOAD_COUNT },
    (_, i) => `scroll-${Date.now()}-${i}.png`
  );
  await uploadSampleImages(page, uploadedNames);

  await page.goto('/app/gallery');
  const tiles = page.locator('[data-test-id="file-card"]');
  await expect(tiles).toHaveCount(UPLOAD_COUNT);

  // Bring a deep tile into view so the window is scrolled away from the top.
  // The masonry lays tiles out column by column, so this index picks a tile
  // low in some column rather than the file at that position — which is all
  // the scroll needs, and it still leaves files to arrow onto below. A check
  // that depends on *which* file must select by aria-label instead.
  const deepTile = tiles.nth(UPLOAD_COUNT - 4);
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

  const readScroll = () =>
    page.evaluate(() => ({
      scrollY: window.scrollY,
      pageHeight: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
      cards: document.querySelectorAll('.gallery-card').length
    }));

  // Regression: reaching the offset once was not enough to keep it. The router
  // scrolls to 0,0 when it commits the location this close navigates to, and
  // that landed either side of the restore depending on machine speed — after
  // it on CI, where it silently undid the whole thing. Force that reset here so
  // the outcome does not depend on who happens to write last.
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0 }));

  // The app restores scroll on a deferred frame, so poll rather than read once.
  try {
    await expect
      .poll(async () => Math.abs((await readScroll()).scrollY - baseline))
      .toBeLessThan(SCROLL_TOLERANCE_PX);
  } catch (err) {
    // A bare pixel delta cannot distinguish "never restored" from "restored
    // onto a page that was still too short to reach the offset", which are
    // opposite bugs. Report the page state with the failure.
    throw new Error(
      `scroll restore missed: baseline=${baseline} ` +
        `state=${JSON.stringify(await readScroll())}`,
      { cause: err }
    );
  }
});
