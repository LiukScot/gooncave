import { expect, test, type Page } from './helpers';

const LONG_NAME = 'Leafeon transformation accident by lodetail, part two of the long series';

const post = (id: string) => ({
  remoteId: id, siteId: 'fixture', siteName: 'Fixture', engine: 'e621',
  previewUrl: '/favicon.png', sampleUrl: null, fileUrl: '/favicon.png',
  width: 640, height: 480, score: 0, rating: null, md5: null, createdAt: null,
  tags: [], favCount: null, uploader: null, fileExt: 'png', fileSize: null,
  favorited: false, voted: null, sourceUrl: `https://fixture.invalid/posts/${id}`,
  parentId: null, hasChildren: false, poolIds: [], localFileId: null, position: Number(id)
});

async function openLongPool(page: Page) {
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [{
    id: 'fixture', name: 'Fixture', engine: 'e621', baseUrl: 'https://fixture.invalid',
    enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
    engineCredentialSchema: 'username_api_key', sortOrder: 0
  }] } }));
  await page.route('**/explore/pool?*', (route) => route.fulfill({ json: {
    poolId: '7', siteId: 'fixture', siteName: 'Fixture', name: LONG_NAME, postCount: 2, page: 1, pageSize: 50,
    posts: [post('1'), post('2')], postIds: ['1', '2']
  } }));
  await page.goto('/app/pool?site=fixture&pool=7');
  await expect(page.getByRole('heading', { name: LONG_NAME })).toBeVisible();
}

/**
 * The heading's box, where its text is drawn (after any scrolling) and on how many lines, and the
 * leftmost of the pool's buttons after it on its line.
 */
const layout = (page: Page) => page.evaluate(() => {
  const heading = document.querySelector('h1')!;
  const box = heading.getBoundingClientRect();
  const text = document.createRange();
  text.selectNodeContents(document.createTreeWalker(heading, NodeFilter.SHOW_TEXT).nextNode()!);
  const buttons = [...document.querySelectorAll('.pool-head-bar button, .pool-head-bar a')]
    .map((each) => each.getBoundingClientRect())
    .filter((button) => button.width > 0 && button.left >= box.left && button.top < box.bottom && button.bottom > box.top);
  return {
    headingRight: box.right,
    textLeft: text.getBoundingClientRect().left,
    lines: new Set([...text.getClientRects()].map((rect) => Math.round(rect.top))).size,
    buttonsLeft: Math.min(...buttons.map((button) => button.left)),
    pageWidth: document.documentElement.scrollWidth,
    viewWidth: window.innerWidth
  };
});

test.describe('desktop window', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a long pool name ends before the buttons in the bar and scrolls to show the rest', async ({ page }) => {
    await openLongPool(page);
    // The browser has no window buttons: this is the class the desktop window sets.
    await page.evaluate(() => document.documentElement.classList.add('has-window-controls'));
    await page.waitForTimeout(300);
    const before = await layout(page);
    expect(before.headingRight).toBeLessThanOrEqual(before.buttonsLeft);
    expect(before.lines).toBe(1);
    await page.waitForTimeout(3_000);
    expect((await layout(page)).textLeft).toBeLessThan(before.textLeft);
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('a long pool name stays on one line beside the buttons without widening the page', async ({ page }) => {
    await openLongPool(page);
    const { headingRight, buttonsLeft, lines, pageWidth, viewWidth } = await layout(page);
    expect(headingRight).toBeLessThanOrEqual(buttonsLeft);
    expect(lines).toBe(1);
    expect(pageWidth).toBeLessThanOrEqual(viewWidth);
  });
});
