import { distinctPicture, startFakeBooru, type FakeBooru } from './fakeBooru';
import { expect, test } from './helpers';

const PAGE_SIZE = 40;
const FIRST_SITE_POSTS = 60;

test('a copy from another site that arrives on a later page joins the tile already shown', async ({ page }) => {
  const shared = distinctPicture(1);
  const sites: FakeBooru[] = [];
  const original = await (await page.request.get('/settings/extra')).json();
  const stacking = await page.request.put('/settings/extra', { data: { exploreStackDuplicates: true } });
  expect(stacking.ok(), 'failed to turn on stacking').toBeTruthy();
  try {
    // The site lists its newest post first, so its post 1, with the shared picture, comes last.
    sites.push(await startFakeBooru(page, 'first', Array.from({ length: FIRST_SITE_POSTS }, (_, index) => ({
      id: index + 1,
      picture: index === 0 ? shared : distinctPicture(index + 100)
    }))));
    sites.push(await startFakeBooru(page, 'second', [{ id: 99, picture: shared }]));

    await page.goto('/app/explore');
    const cards = page.getByRole('button', { name: /^Open post / });
    await expect(cards).toHaveCount(PAGE_SIZE);
    await expect(page.getByRole('button', { name: /Sources:/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Load more' }).click();
    // The core compared the pictures, which differ in checksum, and found them the same.
    await expect(page.getByRole('button', { name: /^Current source second\..*Sources: first\. 1 of 2\./ })).toBeVisible();
    // The rest of the first site, less its copy, which went into the tile already shown.
    await expect(cards).toHaveCount(FIRST_SITE_POSTS + 1 - 1);
  } finally {
    for (const site of sites) await site.close();
    await page.request.put('/settings/extra', { data: { exploreStackDuplicates: original.exploreStackDuplicates } });
  }
});
