import { expect, test, type Page, waitForAnimations } from './helpers';

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
  await waitForAnimations(page);

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
  await waitForAnimations(page);
  await page.getByRole('link', { name: /appearance/i }).first().click();
  // a window the compositor does not draw holds its animations at the start
  await expect(page.locator('.settings-stage[data-slide]')).toHaveCount(1);
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) animation.pause();
  });
  await expect(page.locator('.settings-leaving')).toBeEmpty({ timeout: 2500 });
  await expect(page.locator('.settings-stage[data-slide]')).toHaveCount(0);
});

test('the desktop window bar stays under the pinned title while a Settings page slides', async ({ page }) => {
  await page.goto('/app/settings');
  await expect(page.getByRole('link', { name: /appearance/i }).first()).toBeVisible();
  // The browser has no window buttons, so the bar the desktop window draws is given a height here.
  await page.evaluate(() => {
    document.documentElement.classList.add('has-window-controls');
    const style = document.createElement('style');
    style.textContent = 'html.has-window-controls body::before { height: 64px !important; }';
    document.head.append(style);
  });
  await waitForAnimations(page);
  await page.getByRole('link', { name: /appearance/i }).first().click();
  await expect(page.locator('.settings-stage[data-slide]')).toHaveCount(1);
  // Held near the end of the slide, with the new page's title where it stays.
  // The bar is body::before, so a point it covers reports the body.
  const topElement = await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = 390;
    }
    const title = document.querySelector('.settings-page .settings-subpage-head')!.getBoundingClientRect();
    const hit = document.elementFromPoint(title.left + title.width / 2, title.top + title.height / 2);
    return hit === document.body ? 'window bar' : (hit?.closest('.settings-subpage-head') ? 'title' : hit?.className);
  });
  expect(topElement).toBe('title');
});
