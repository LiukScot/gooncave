import { expect, test } from '@playwright/test';

// A phone: no hover, a coarse pointer (Blink: none = 1, coarse = 2). The browser keeps the last
// touched spot "hovered", which is what showed the buttons for good.
test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
  launchOptions: {
    args: ['--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2']
  }
});

test('the buttons on a picture show for a few seconds after a touch and then hide', async ({ page }) => {
  await page.goto('/app/gallery');
  await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').tap();
  await expect(page).toHaveURL(/fileId=/);

  const button = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
  // The tap that opened the file left the "hovered" spot over the picture; that must not show the buttons.
  await expect(button).toHaveCSS('opacity', '0');

  await page.locator('.file-detail-panel-current .file-detail-media-wrap').tap();
  await expect(button).toHaveCSS('opacity', '1');
  await expect(button).toHaveCSS('opacity', '0', { timeout: 6_000 });
});
