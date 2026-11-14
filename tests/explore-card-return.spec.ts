import { expect, test } from '@playwright/test';

import type { ExplorePost } from '../frontend/src/api';

import { thumbnailablePng } from './helpers';

const POST_COUNT = 120;
// The pictures come back this late the second time, so the window where a returning card has no
// picture yet can be seen.
const RELOAD_DELAY_MS = 800;
const OBSERVE_MS = 1_500;
const MAX_SHIFT_PX = 2;

test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });

test('a card without a known size keeps its height on its way back until its picture has loaded', async ({ page }) => {
  const posts: ExplorePost[] = Array.from({ length: POST_COUNT }, (_, index) => ({
    remoteId: String(index + 1), siteId: 'fixture', siteName: 'Fixture', engine: 'e621',
    previewUrl: `https://img.fixture.invalid/${index + 1}.png`, sampleUrl: null, fileUrl: null,
    width: null, height: null, score: 0, rating: null, md5: null, createdAt: null,
    tags: [], favCount: null, uploader: null, fileExt: 'png', fileSize: null, favorited: false, voted: null,
    sourceUrl: `https://fixture.invalid/posts/${index + 1}`, parentId: null, hasChildren: false, poolIds: []
  }));
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [{
    id: 'fixture', name: 'Fixture', engine: 'e621', baseUrl: 'https://fixture.invalid',
    enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
    engineCredentialSchema: 'username_api_key', sortOrder: 0
  }] } }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: { posts, siteErrors: [], sites: ['fixture'], hasMore: false } }));
  // A portrait picture: loaded, a card is taller than the square it is until then.
  const requests = new Map<string, number>();
  await page.route('https://img.fixture.invalid/**', async (route) => {
    const url = route.request().url();
    const count = (requests.get(url) ?? 0) + 1;
    requests.set(url, count);
    if (count > 1) await new Promise((resolve) => setTimeout(resolve, RELOAD_DELAY_MS));
    await route.fulfill({ contentType: 'image/png', headers: { 'cache-control': 'no-store' }, body: Buffer.from(thumbnailablePng, 'base64') });
  });
  await page.goto('/app/explore');
  // Chromium keeps the reader's place when content above them changes height; WebKit, on the iPhone, does not.
  await page.addStyleTag({ content: '* { overflow-anchor: none !important; }' });
  await expect(page.locator('[data-test-id="explore-card"]').first()).toBeVisible();

  // Down to the bottom, so that every picture loads once and the cards far above give theirs back.
  for (let step = 0; step < POST_COUNT; step += 1) {
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-test-id="explore-card"]'))
      .filter((card) => card.getBoundingClientRect().bottom > 0 && card.getBoundingClientRect().top < window.innerHeight)
      .every((card) => card.querySelector('img')?.complete));
    const atBottom = await page.evaluate(() => {
      window.scrollBy({ top: window.innerHeight / 2, behavior: 'instant' });
      return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 1;
    });
    if (atBottom) break;
  }
  await expect(page.locator('[data-test-id="explore-card-placeholder"]').first()).toBeAttached();
  // Chromium reuses a picture it still holds for the page, however its response says to cache it.
  // The released ones go with a collection, so that they are fetched again like on a long feed.
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('HeapProfiler.collectGarbage');
  } finally {
    await session.detach();
  }

  // Back up to the middle of the feed at once: the cards above the reader return together. The
  // position of each card in the page must not change, whatever the scroll does.
  const { watched, worst } = await page.evaluate(async ({ observeMs }) => {
    const documentTop = (card: Element) => card.getBoundingClientRect().top + window.scrollY;
    const target = (document.documentElement.scrollHeight - window.innerHeight) / 2;
    const watched = Array.from(document.querySelectorAll('[data-test-id="explore-card"]'))
      .map((card) => ({ card, top: documentTop(card) }))
      .filter(({ top }) => top >= target && top < target + window.innerHeight);
    window.scrollTo({ top: target, behavior: 'instant' });
    let worst = 0;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        for (const { card, top } of watched) worst = Math.max(worst, Math.abs(documentTop(card) - top));
        if (performance.now() - start < observeMs) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return { watched: watched.length, worst };
  }, { observeMs: OBSERVE_MS });
  expect(watched).toBeGreaterThan(0);
  // The pictures above did load again, late.
  expect([...requests.values()].some((count) => count > 1)).toBe(true);
  expect(worst).toBeLessThanOrEqual(MAX_SHIFT_PX);
});
