import { expect, test } from '@playwright/test';

const tags = (count: number) => Array.from({ length: count }, (_, i) => `tag_${i + 1}`);

const pages = [
  { path: '/app/settings/blacklist', put: (page, list) => page.request.put('/settings/blacklist', { data: { tags: list } }) },
  { path: '/app/settings/subscriptions', put: (page, list) => page.request.put('/settings/subscriptions/tags', { data: { tags: list } }) }
];

for (const { path, put } of pages) {
  test.describe(path, () => {
    test.afterEach(async ({ page }) => {
      await put(page, []);
    });

    for (const count of [1, 10, 100]) {
      test(`${count} tags: ${count > 8 ? 'folds after 8 and unfolds' : 'no Show more'}`, async ({ page }) => {
        await put(page, tags(count));
        await page.goto(path);
        const more = page.getByRole('button', { name: /^Show more/ });
        if (count <= 8) {
          await expect(more).toHaveCount(0);
          return;
        }
        await expect(page.getByText(/^tag_\d+$/)).toHaveCount(8);
        await more.click();
        await expect(page.getByText(/^tag_\d+$/)).toHaveCount(count);
        await page.getByRole('button', { name: 'Show less' }).click();
        await expect(page.getByText(/^tag_\d+$/)).toHaveCount(8);
      });
    }
  });
}

test('a tag is added to and removed from the blacklist', async ({ page }) => {
  await page.request.put('/settings/blacklist', { data: { tags: [] } });
  await page.goto('/app/settings/blacklist');
  await page.getByLabel('New tag').fill('Wolf, big');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('big', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove wolf from the blacklist' }).click();
  await expect(page.getByText('wolf', { exact: true })).toHaveCount(0);
  await page.request.put('/settings/blacklist', { data: { tags: [] } });
});
