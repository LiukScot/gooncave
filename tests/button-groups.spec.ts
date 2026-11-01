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

test('a chosen option keeps the shape of its place in the group', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('gooncave:appearance', JSON.stringify({ mode: 'dark', accent: 'mono' }));
  });
  await page.goto('/app/gallery');
  await page.getByRole('button', { name: /^Search and filter/ }).click();
  const group = page.getByRole('group', { name: 'Order by' });
  const newest = group.getByRole('button', { name: 'Newest' });
  const oldest = group.getByRole('button', { name: 'Oldest' });

  await newest.click();
  await page.waitForTimeout(500);
  const whenChosen = await radii(newest);
  await oldest.click();
  await expect.poll(() => radii(newest)).toBe(whenChosen);

  // every corner keeps its radius: a 999px end would shrink the inner ones to nothing
  for (const button of await group.getByRole('button').all()) {
    for (const corner of (await radii(button)).split(' ')) {
      expect(parseFloat(corner)).toBeGreaterThanOrEqual(8);
    }
  }
});
