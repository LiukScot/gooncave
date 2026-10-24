import { expect, test, type Page } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });

async function swipeFromEdge(page: Page, distance: number) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, x: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y: 400 }]
    });
  await touch('touchStart', 4);
  for (let x = 4; x <= distance; x += 12) await touch('touchMove', x);
  await touch('touchEnd', distance);
}

async function openFirstFile(page: Page) {
  await page.goto('/app/gallery');
  await page.locator('.gallery-thumb').first().click();
  await expect(page).toHaveURL(/fileId=/);
  // the pushed entry is recorded once the URL has been written
  await page.waitForTimeout(500);
}

test('a swipe from the left edge past a third of the width leaves the file', async ({ page }) => {
  await openFirstFile(page);
  await swipeFromEdge(page, 220);
  await expect(page).not.toHaveURL(/fileId=/);
  await expect(page.locator('.gallery-thumb').first()).toBeVisible();
});

test('a short swipe from the edge keeps the file open', async ({ page }) => {
  await openFirstFile(page);
  const url = page.url();
  await swipeFromEdge(page, 60);
  await page.waitForTimeout(1200);
  expect(page.url()).toBe(url);
  await expect(page.locator('.file-detail-frame')).toBeVisible();
});

test('a file can still be swiped away after a short swipe let it stay', async ({ page }) => {
  await openFirstFile(page);
  await swipeFromEdge(page, 60);
  await page.waitForTimeout(1200);
  await expect(page).toHaveURL(/fileId=/);
  await swipeFromEdge(page, 220);
  await expect(page).not.toHaveURL(/fileId=/);
});

test('a swipe from the edge leaves a Settings page for the Settings menu', async ({ page }) => {
  await page.goto('/app/settings');
  await page.getByRole('link', { name: /appearance/i }).first().click();
  await expect(page).toHaveURL(/settings\/appearance/);
  await page.waitForTimeout(500);
  await swipeFromEdge(page, 220);
  await expect(page).toHaveURL(/\/app\/settings\/?$/);
});

test('a swipe that starts away from the edge does not leave the file', async ({ page }) => {
  await openFirstFile(page);
  const url = page.url();
  await page.touchscreen.tap(200, 300);
  await page.waitForTimeout(300);
  expect(page.url()).toBe(url);
});
