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

test('only the open tab takes the chosen colour', async ({ page }) => {
  await choose(page, 'tint-6');
  const { fill, ink } = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'hsl(var(--primary))';
    probe.style.color = 'hsl(var(--primary-foreground))';
    document.body.append(probe);
    const { backgroundColor, color } = getComputedStyle(probe);
    probe.remove();
    return { fill: backgroundColor, ink: color };
  });
  const open = page.locator('.app-tab-bar-link.is-active');
  await expect(open).toHaveCSS('background-color', fill);
  await expect(open).toHaveCSS('color', ink);
  await expect(page.locator('.app-tab-bar-link:not(.is-active)').first()).not.toHaveCSS('background-color', fill);
});

test('a tonal button changes under the pointer', async ({ page }) => {
  await choose(page, 'blue');
  const button = page.getByRole('button', { name: 'No filters' });
  const atRest = await button.evaluate((element) => getComputedStyle(element).backgroundColor);
  await button.hover();
  await expect(button).not.toHaveCSS('background-color', atRest);
});

test('a chosen picture button keeps the colour under the pointer', async ({ page }) => {
  await choose(page, 'tint-6');
  await page.getByRole('button', { name: /landscape\.png/ }).click();
  await page.locator('.file-detail-panel-current .file-detail-media').hover();
  const button = page.locator('.file-detail-panel-current .file-detail-overlay-btn').first();
  await button.evaluate((element) => element.classList.add('is-on'));
  await button.hover();
  const fill = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'hsl(var(--primary))';
    document.body.append(probe);
    const { backgroundColor } = getComputedStyle(probe);
    probe.remove();
    return backgroundColor;
  });
  await expect(button).toHaveCSS('background-color', fill);
});

for (const mode of ['dark', 'light']) {
  test(`${mode}: an off switch stands out from its track`, async ({ page }) => {
    await choose(page, 'blue', mode);
    const ratio = await page.evaluate(() => {
      const luminance = (token: string) => {
        const probe = document.createElement('div');
        probe.style.color = `hsl(var(${token}))`;
        document.body.append(probe);
        const [r, g, b] = getComputedStyle(probe).color.match(/[\d.]+/g)!.map((value) => {
          const channel = Number(value) / 255;
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        probe.remove();
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const [high, low] = [luminance('--input'), luminance('--muted')].sort((a, b) => b - a);
      return (high + 0.05) / (low + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(3);
  });
}

test('opening a picture does not repaint the page', async ({ page }) => {
  await choose(page, 'tint-4');
  const before = await page.evaluate(() => document.documentElement.getAttribute('style'));
  // The first card is a video, whose middle is its play button.
  await page.getByRole('button', { name: /landscape\.png/ }).click();
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
