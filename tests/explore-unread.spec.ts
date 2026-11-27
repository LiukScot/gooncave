import { markRead, startFakeBooru, type FakeBooru } from './fakeBooru';
import { expect, test } from './helpers';

const SITES = ['one', 'two', 'three', 'four'];
const POSTS_PER_SITE = 1_000;
// The reader has seen the newest posts of every site: more than one load used to get through.
const READ_PER_SITE = 600;
const SHOWN_PER_LOAD = 40;

test('Unread only shows a full page, and the next one, when the newest posts of every site are read', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('imagesearch.unreadOnly.explore', '1'));
  const ids = Array.from({ length: POSTS_PER_SITE }, (_, index) => POSTS_PER_SITE - index);
  const sites: FakeBooru[] = [];
  try {
    for (const name of SITES) {
      const site = await startFakeBooru(page, name, ids.map((id) => ({ id })));
      sites.push(site);
      await markRead(page, site.siteId, ids.slice(0, READ_PER_SITE));
    }
    const asked = () => sites.reduce((count, site) => count + site.pagesAsked.length, 0);

    await page.goto('/app/explore');
    const cards = page.getByRole('button', { name: /^Open post / });
    await expect(cards).toHaveCount(SHOWN_PER_LOAD);
    // Seven pages of a hundred posts get each site past its read posts.
    for (const site of sites) expect(site.pagesAsked.length).toBeLessThanOrEqual(7);

    const before = asked();
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(cards).toHaveCount(SHOWN_PER_LOAD * 2);
    expect(asked(), 'the posts already fetched are shown before the sites are asked again').toBe(before);
  } finally {
    for (const site of sites) await site.close();
  }
});
