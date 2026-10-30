import { expect, test, type Page } from '@playwright/test';

const surfaces = (page: Page) =>
  page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return ['--page-background', '--background', '--card', '--muted', '--section'].map((token) =>
      root.getPropertyValue(token).trim()
    );
  });

const choose = async (page: Page, accent: string, mode = 'dark') => {
  await page.goto('/app/gallery');
  await page.evaluate(
    ([a, m]) => localStorage.setItem('gooncave:appearance', JSON.stringify({ mode: m, accent: a })),
    [accent, mode]
  );
  await page.reload();
};

test('the chosen colour changes the accent and never a surface', async ({ page }) => {
  await choose(page, 'blue');
  const base = await surfaces(page);
  const blue = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary'));
  await page.evaluate(() => localStorage.setItem('gooncave:appearance', JSON.stringify({ mode: 'dark', accent: 'tint-6' })));
  await page.reload();
  expect(await surfaces(page)).toEqual(base);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary'))).not.toBe(blue);
  expect(base[0]).toBe('0 0% 0%');
});

test('light mode keeps neutral greys for every colour', async ({ page }) => {
  await choose(page, 'tint-2', 'light');
  const first = await surfaces(page);
  await page.evaluate(() => localStorage.setItem('gooncave:appearance', JSON.stringify({ mode: 'light', accent: 'tint-9' })));
  await page.reload();
  expect(await surfaces(page)).toEqual(first);
});

test('opening a picture does not repaint the page', async ({ page }) => {
  await choose(page, 'tint-4');
  const before = await page.evaluate(() => document.documentElement.getAttribute('style'));
  await page.locator('.gallery-thumb').first().click();
  await expect(page.locator('.file-detail-panel-current .file-detail-tags')).toBeVisible();
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => document.documentElement.getAttribute('style'))).toBe(before);
});

test('a style saved by an older version still opens the app', async ({ page }) => {
  await page.goto('/app/gallery');
  await page.evaluate(() =>
    localStorage.setItem('gooncave:appearance', JSON.stringify({ mode: 'dark', style: 'apple', accent: 'blue' }))
  );
  await page.goto('/app/settings/appearance');
  await expect(page.getByRole('heading', { name: 'Mode' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Style' })).toHaveCount(0);
});
