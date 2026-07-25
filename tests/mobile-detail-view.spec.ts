import { expect, test } from '@playwright/test';

import { loginUi, uploadSampleImages } from './helpers';

// A phone-sized touch viewport: the detail view's back and fullscreen
// handling only breaks once hover is absent and the page scrolls.
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true
});

const UPLOAD_COUNT = 4;

// One test rather than four: /auth/login allows 10 requests per minute and
// the rest of the suite already sits close to that ceiling. The scenarios are
// independent — each one re-enters from the gallery — so they are steps.
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

test('detail view is navigable on a touch device', async ({ page }) => {
  await loginUi(page);
  uploadedNames = Array.from(
    { length: UPLOAD_COUNT },
    (_, i) => `mobile-${Date.now()}-${i}.png`
  );
  await uploadSampleImages(page, uploadedNames);

  const tiles = page.locator('[data-test-id="file-card"]');
  const fullscreenButton = page.locator(
    '.file-detail-panel-current .file-detail-fullscreen-btn'
  );
  const overlay = page.locator('.file-detail-media-wrap.is-fullscreen');
  // The smoke DB is seeded and shared across specs, so assert on "enough
  // tiles to have a neighbour on both sides" rather than an exact count.
  const gotoGallery = async () => {
    await page.goto('/app/gallery');
    await expect.poll(() => tiles.count()).toBeGreaterThanOrEqual(3);
  };
  const openDetail = async () => {
    await gotoGallery();
    await tiles.nth(1).click();
    await expect(page).toHaveURL(/\/app\/gallery\?fileId=/);
    await expect(page.getByText('File name:').first()).toBeVisible();
  };

  // Regression: back popped fileId out of the URL, then a second sync effect
  // — still holding the pre-close selection — wrote it straight back and
  // reopened the file. The detail view was inescapable, and a second back
  // skipped past the gallery entirely.
  await test.step('browser back returns to the gallery', async () => {
    await openDetail();
    await page.evaluate(() => window.history.back());

    await expect(page).toHaveURL(/\/app\/gallery$/);
    await expect(page.getByText('File name:')).toHaveCount(0);
    await expect(tiles.first()).toBeVisible();
  });

  // Regression: `.file-detail-track` carries `will-change: transform`, which
  // makes it the containing block for fixed-position descendants. The overlay
  // anchored to the track instead of the viewport, so it hung off the bottom
  // of the screen with its exit button out of reach while scroll was locked.
  await test.step('fullscreen overlay covers the viewport', async () => {
    await openDetail();
    await fullscreenButton.click();
    await expect(overlay).toBeVisible();

    const geometry = await page.evaluate(() => {
      const el = document.querySelector(
        '.file-detail-media-wrap.is-fullscreen'
      )!;
      const rect = el.getBoundingClientRect();
      return {
        top: rect.top,
        left: rect.left,
        bottom: rect.bottom,
        right: rect.right,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth
      };
    });

    expect(geometry.top).toBe(0);
    expect(geometry.left).toBe(0);
    expect(geometry.bottom).toBeGreaterThanOrEqual(geometry.viewportHeight);
    expect(geometry.right).toBeGreaterThanOrEqual(geometry.viewportWidth);

    // The exit control must be inside the viewport, not clipped off-screen.
    const exitBox = await page
      .locator(
        '.file-detail-media-wrap.is-fullscreen .file-detail-fullscreen-btn'
      )
      .boundingBox();
    expect(exitBox).not.toBeNull();
    expect(exitBox!.y + exitBox!.height).toBeLessThanOrEqual(
      geometry.viewportHeight
    );
  });

  // Fullscreen owns a history entry, so the phone's back gesture steps out of
  // it instead of abandoning the file.
  await test.step('back exits fullscreen and keeps the file open', async () => {
    await openDetail();
    await fullscreenButton.click();
    await expect(page).toHaveURL(/fs=true/);

    await page.evaluate(() => window.history.back());

    await expect(page).not.toHaveURL(/fs=true/);
    await expect(page).toHaveURL(/fileId=/);
    await expect(page.getByText('File name:').first()).toBeVisible();
    await expect(overlay).toHaveCount(0);
  });

  // Regression: the off-screen prev/next preview panels pointed at
  // /files/:id/content — the original file — so opening one image pulled
  // three full-size downloads, and every swipe pulled more.
  await test.step('only the active file is fetched at full size', async () => {
    await gotoGallery();

    const fullSizeRequests: string[] = [];
    page.on('request', (request) => {
      if (/\/files\/[^/]+\/content/.test(request.url())) {
        fullSizeRequests.push(request.url());
      }
    });

    await tiles.nth(1).click();
    await expect(page.getByText('File name:').first()).toBeVisible();
    // Let the neighbouring preview panels settle before counting.
    await expect
      .poll(() => fullSizeRequests.length, { timeout: 5_000 })
      .toBeGreaterThan(0);

    expect(new Set(fullSizeRequests).size).toBe(1);
  });
});
