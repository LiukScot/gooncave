import { expect, test } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });

test('moving to the next file never shows the previous file’s tags or an update spinner', async ({ page }) => {
  await page.route('**/files/*/tags', async (route) => {
    const id = route.request().url().split('/files/')[1].split('/')[0];
    await route.fulfill({
      json: {
        tags: [{ tag: `tag_${id}`, canonicalTag: `tag_${id}`, category: 'general', source: 'manual', score: null, sourceUrl: null }],
        implied: [],
        favoriteSources: []
      }
    });
  });
  await page.goto('/app/gallery');
  await page.locator('.gallery-thumb').first().click();
  const current = page.locator('.file-detail-panel-current');
  await expect(current.locator('.file-detail-tags')).toContainText('tag_');
  const first = (await current.locator('.file-detail-tags').innerText()).match(/tag_\S+/)![0];
  // let the neighbours' tags land in the cache
  await page.waitForTimeout(800);

  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __seen: string[] }).__seen = seen;
    new MutationObserver(() => {
      const section = document.querySelector('.file-detail-panel-current .file-detail-tags');
      if (!section) return;
      const text = (section as HTMLElement).innerText;
      seen.push(`${/Updating tags/.test(text) ? 'spinner ' : ''}${(text.match(/tag_\S+/) ?? ['none'])[0]}`);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(1200);

  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  const last = seen.at(-1)!;
  expect(last).not.toContain(first);
  expect(seen.filter((entry) => entry.includes('spinner') || entry.endsWith('none'))).toEqual([]);
});

test('the neighbour that slides in carries the same buttons as the open file', async ({ page }) => {
  await page.goto('/app/gallery');
  await page.locator('.gallery-thumb').first().click();
  await expect(page.locator('.file-detail-panel-current .file-detail-tags')).toBeVisible();
  const count = (panel: string, selector: string) => page.locator(`.file-detail-panel-${panel} ${selector}`).count();
  for (const selector of ['.file-detail-icon-button', '.file-detail-overlay-back', '.file-detail-fullscreen-btn']) {
    const open = await count('current', selector);
    expect(open, selector).toBeGreaterThan(0);
    expect(await count('next', selector), selector).toBe(open);
  }
});
