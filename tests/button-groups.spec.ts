import { expect, test, type Locator } from '@playwright/test';

const radii = (button: Locator) =>
  button.evaluate((element) => {
    const style = getComputedStyle(element);
    return [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius
    ].join(' ');
  });

for (const style of ['material', 'custom']) {
  test(`${style}: a chosen option keeps the shape of its place in the group`, async ({ page }) => {
    await page.addInitScript((value) => {
      localStorage.setItem('gooncave:appearance', JSON.stringify({ mode: 'dark', style: value, accent: 'mono' }));
    }, style);
    await page.goto('/app/gallery');
    const group = page.locator('.btn-group').first();
    const newest = group.getByRole('button', { name: 'Newest' });
    const oldest = group.getByRole('button', { name: 'Oldest' });

    await newest.click();
    await page.waitForTimeout(500);
    const whenChosen = await radii(newest);
    await oldest.click();
    await expect.poll(() => radii(newest)).toBe(whenChosen);

    // Custom joins its segments with square inner corners on purpose.
    if (style !== 'material') return;
    // every corner keeps its radius: a 999px end would shrink the inner ones to nothing
    for (const button of await group.getByRole('button').all()) {
      for (const corner of (await radii(button)).split(' ')) {
        expect(parseFloat(corner)).toBeGreaterThanOrEqual(8);
      }
    }
  });
}
