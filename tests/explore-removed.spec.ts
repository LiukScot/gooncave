import { startFakeBooru } from './fakeBooru';
import { expect, test } from './helpers';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

// Landscape, as the post that showed it: its tile is shorter than an empty tile's own height.
test('a post the site deleted says so, in the middle of its tile', async ({ page, allowConsoleError }) => {
  // The core relays the site's 404 for the deleted picture as a failed fetch.
  allowConsoleError(/explore\/media\/.*502/);
  const site = await startFakeBooru(page, 'gone', [{ id: 2 }, { id: 1, removed: true, size: { width: 2048, height: 1583 } }]);
  try {
    await page.goto('/app/explore');
    const card = page.getByRole('button', { name: /^Open post 1 from gone/ });
    const label = card.getByText('Removed from gone');
    await expect(label).toBeVisible();
    const box = (await card.boundingBox())!;
    const text = (await label.boundingBox())!;
    expect(Math.abs(text.y + text.height / 2 - (box.y + box.height / 2))).toBeLessThan(2);
    expect(Math.abs(text.x + text.width / 2 - (box.x + box.width / 2))).toBeLessThan(2);
  } finally {
    await site.close();
  }
});
