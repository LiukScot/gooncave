import { expect, test, type Page } from './helpers';

test.use({ viewport: { width: 1280, height: 800 } });

/** What the page shows 150ms into the 400ms slide. */
async function midSlide(page: Page, go: () => Promise<void>) {
  await go();
  await page.waitForTimeout(150);
  return page.evaluate(() => ({
    viewTransition: document.documentElement.matches(':active-view-transition'),
    slide: document.querySelector<HTMLElement>('.settings-stage')?.dataset.slide ?? null,
    leaving: document.querySelector('.settings-leaving')?.textContent ?? ''
  }));
}

// Chromium draws a view-transition picture of the page being left white under a
// fractional display scale, so that page has to stay made of elements.
test('the Settings page being left slides away as elements, not as a picture', async ({ page }) => {
  await page.goto('/app/settings');
  await expect(page.getByRole('link', { name: /appearance/i }).first()).toBeVisible();
  await page.waitForTimeout(300);

  const push = await midSlide(page, () => page.getByRole('link', { name: /appearance/i }).first().click());
  expect(push).toMatchObject({ viewTransition: false, slide: 'push' });
  expect(push.leaving).toMatch(/appearance/i);
  await expect(page.locator('.settings-leaving')).toBeEmpty();

  const pop = await midSlide(page, () => page.getByRole('link', { name: /back to settings/i }).click());
  expect(pop).toMatchObject({ viewTransition: false, slide: 'pop' });
  expect(pop.leaving).toMatch(/back to settings/i);
  await expect(page.locator('.settings-leaving')).toBeEmpty();
  await expect(page).toHaveURL(/\/app\/settings\/?$/);
});

test('the copy of the page left goes away when its animation never advances', async ({ page }) => {
  await page.goto('/app/settings');
  await expect(page.getByRole('link', { name: /appearance/i }).first()).toBeVisible();
  await page.waitForTimeout(300);
  await page.getByRole('link', { name: /appearance/i }).first().click();
  // a window the compositor does not draw holds its animations at the start
  await expect(page.locator('.settings-stage[data-slide]')).toHaveCount(1);
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) animation.pause();
  });
  await expect(page.locator('.settings-leaving')).toBeEmpty({ timeout: 2500 });
  await expect(page.locator('.settings-stage[data-slide]')).toHaveCount(0);
});
