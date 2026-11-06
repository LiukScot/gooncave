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
  for (const selector of ['.file-detail-ghost-button', '.file-detail-overlay-back', '.file-detail-fullscreen-btn']) {
    const open = await count('current', selector);
    expect(open, selector).toBeGreaterThan(0);
    expect(await count('next', selector), selector).toBe(open);
  }
});

test('the stand-in thumbnail of a very tall picture stays inside the picture', async ({ page }) => {
  await page.goto('/app/gallery');
  await page.locator('.gallery-thumb').first().click();
  const wrap = page.locator('.file-detail-panel-current .file-detail-media-wrap');
  await expect(wrap).toBeVisible();
  // A 1:4 file, whose thumbnail is a 1:2 strip cropped from its top.
  const box = await wrap.evaluate((element) => {
    (element as HTMLElement).style.setProperty('--file-detail-aspect', '1000 / 4000');
    const wrapBox = element.getBoundingClientRect();
    const poster = getComputedStyle(element, '::before');
    return { wrapWidth: wrapBox.width, wrapHeight: wrapBox.height, width: parseFloat(poster.width), height: parseFloat(poster.height) };
  });
  expect(box.width).toBeLessThan(box.wrapWidth);
  expect(box.width).toBeCloseTo(box.height / 4, 0);
});

test('a section hidden in Appearance stays hidden on every file', async ({ page }) => {
  await page.goto('/app/gallery');
  await page.locator('.gallery-thumb').first().click();
  const current = page.locator('.file-detail-panel-current');
  const tagsTitle = current.locator('.file-detail-section-title', { hasText: /^Tags$/ });
  await expect(tagsTitle).toBeVisible();

  const fileUrl = page.url();
  await page.goto('/app/settings/appearance');
  const tagsToggle = page.getByRole('group', { name: 'More sections shown under the file' }).getByRole('button', { name: 'Tags', exact: true });
  await expect(tagsToggle).toHaveAttribute('aria-pressed', 'true');
  await tagsToggle.click();
  await expect(tagsToggle).toHaveAttribute('aria-pressed', 'false');
  await page.goto(fileUrl);
  await expect(current.locator('.file-detail-section-title', { hasText: /^File info$/ })).toBeVisible();
  await expect(tagsTitle).toHaveCount(0);
  // File info is now first: no divider above it.
  const firstVisibleDivider = await current.locator('.file-detail-body > .file-detail-section-divider').evaluateAll(
    (dividers) => dividers.find((divider) => getComputedStyle(divider).display !== 'none')?.nextElementSibling?.textContent ?? null
  );
  expect(firstVisibleDivider).toBeNull();

  await page.reload();
  await expect(page.locator('.file-detail-panel-current .file-detail-section-title', { hasText: /^File info$/ })).toBeVisible();
  await expect(page.locator('.file-detail-panel-current .file-detail-section-title', { hasText: /^Tags$/ })).toHaveCount(0);
});

test('a quick tap on a round button squares it off before it springs back', async ({ page }) => {
  await page.goto('/app/gallery');
  await page.locator('.gallery-thumb').first().click();
  const button = page.locator('.file-detail-panel-current .file-detail-overlay-back');
  await expect(button).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
  const rest = await button.evaluate((element) => parseFloat(getComputedStyle(element).borderTopLeftRadius));
  await button.evaluate((element) => {
    const sample = window as unknown as { smallest: number };
    sample.smallest = Infinity;
    const start = performance.now();
    const tick = () => {
      sample.smallest = Math.min(sample.smallest, parseFloat(getComputedStyle(element).borderTopLeftRadius));
      if (performance.now() - start < 600) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // Press and release at once, as a tap does: :active alone ends before the shape shows.
  await button.dispatchEvent('pointerdown', { button: 0 });
  await button.dispatchEvent('pointerup', { button: 0 });
  await page.waitForTimeout(700);
  const smallest = await page.evaluate(() => (window as unknown as { smallest: number }).smallest);
  expect(smallest).toBeLessThan(rest * 0.7);
});
