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
  for (let x = 4; x <= distance; x += 12) {
    await touch('touchMove', x);
    // slower than a flick, so only the distance decides
    await page.waitForTimeout(40);
  }
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

async function touchDrag(page: Page, from: [number, number], to: [number, number]) {
  const cdp = await page.context().newCDPSession(page);
  const steps = 12;
  const point = (i: number) => ({
    x: from[0] + ((to[0] - from[0]) * i) / steps,
    y: from[1] + ((to[1] - from[1]) * i) / steps
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(0)] });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(i)] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function openAppearance(page: Page) {
  await page.setViewportSize({ width: 375, height: 420 });
  await page.goto('/app/settings');
  await page.getByRole('link', { name: /appearance/i }).first().click();
  await expect(page).toHaveURL(/settings\/appearance/);
  await page.waitForTimeout(500);
}

test('scrolling a Settings page with a thumb that starts at the edge and drifts sideways still scrolls', async ({ page }) => {
  await openAppearance(page);
  await touchDrag(page, [10, 380], [34, 120]);
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/settings\/appearance/);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(40);
});

test('a Settings page scrolls after a short swipe from the edge let it stay', async ({ page }) => {
  await openAppearance(page);
  await swipeFromEdge(page, 60);
  await page.waitForTimeout(1200);
  await expect(page).toHaveURL(/settings\/appearance/);
  await touchDrag(page, [200, 380], [200, 120]);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(40);
});

test('opening a Settings page slides it in', async ({ page }) => {
  await page.goto('/app/settings');
  await page.waitForTimeout(500);
  // the animation lasts 400ms, so every frame is recorded instead of sampled
  await page.evaluate(() => {
    const seen = new Set<string>();
    (window as unknown as { __animations: Set<string> }).__animations = seen;
    const record = () => {
      for (const animation of document.documentElement.getAnimations({ subtree: true })) {
        seen.add((animation as CSSAnimation).animationName);
      }
      requestAnimationFrame(record);
    };
    record();
  });
  await page.getByRole('link', { name: /appearance/i }).first().click();
  await page.waitForTimeout(800);
  const seen = await page.evaluate(() => [...(window as unknown as { __animations: Set<string> }).__animations]);
  expect(seen).toContain('ios-push-in');
});
