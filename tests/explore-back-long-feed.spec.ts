import type { ExplorePost } from '../frontend/src/api';

import { expect, test, thumbnailablePng, type Page } from './helpers';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });

/**
 * The longest frame of the way back from a post opened far down a feed of `count` cards, with the
 * CPU slowed like a phone's, and the time a fixed piece of work takes at that speed. Explore keeps
 * every loaded card mounted under the open post.
 */
async function backFrame(page: Page, count: number): Promise<{ frame: number; reference: number }> {
  const posts: ExplorePost[] = Array.from({ length: count }, (_, index) => ({
    remoteId: String(index + 1), siteId: 'fixture', siteName: 'Fixture', engine: 'e621',
    previewUrl: `https://img.fixture.invalid/${index + 1}.png`, sampleUrl: null,
    fileUrl: `https://img.fixture.invalid/${index + 1}.png`,
    width: 300, height: 300 + (index % 5) * 60, score: 0, rating: null, md5: null, createdAt: null,
    tags: [{ tag: 'fox', category: 'species' }], favCount: null, uploader: null, fileExt: 'png', fileSize: null,
    favorited: false, voted: null, sourceUrl: `https://fixture.invalid/posts/${index + 1}`,
    parentId: null, hasChildren: false, poolIds: []
  }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: { posts, siteErrors: [], sites: ['fixture'], hasMore: false } }));
  await page.goto('/app/explore');
  await expect(page.locator('[data-test-id="explore-card"]').first()).toBeVisible();
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight * 0.9, behavior: 'instant' }));
  await page.waitForTimeout(1_000);
  await page.locator('[data-test-id="explore-card"]').filter({ visible: true }).nth(1).click();
  await expect(page.locator('.file-detail-panel-current')).toBeVisible();
  await page.waitForTimeout(1_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  try {
    // No locator polls while the frames are recorded: a poll's own work would count as the app's.
    return await page.evaluate(() => new Promise<{ frame: number; reference: number }>((resolve) => {
      // The same work on any machine: styling and laying out 3000 plain boxes once.
      const start = performance.now();
      const boxes = document.createElement('div');
      for (let index = 0; index < 3_000; index += 1) {
        const box = boxes.appendChild(document.createElement('div'));
        box.style.cssText = `width:${index % 7 + 40}px;height:${index % 5 + 20}px;display:inline-block`;
        box.textContent = String(index);
      }
      document.body.append(boxes);
      void boxes.offsetHeight;
      boxes.remove();
      const reference = performance.now() - start;
      let longest = 0;
      new PerformanceObserver((list) => {
        for (const frame of list.getEntries()) longest = Math.max(longest, frame.duration);
      }).observe({ type: 'long-animation-frame' });
      history.back();
      setTimeout(() => resolve({ frame: longest, reference }), 2_500);
    }));
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
    await expect(page.locator('.file-detail-panel-current')).toHaveCount(0);
  }
}

test('going back from a post far down a long feed does not freeze the back gesture', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [{
    id: 'fixture', name: 'Fixture', engine: 'e621', baseUrl: 'https://fixture.invalid',
    enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
    engineCredentialSchema: 'username_api_key', sortOrder: 0
  }] } }));
  await page.route('https://img.fixture.invalid/**', (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from(thumbnailablePng, 'base64') }));
  const { frame, reference } = await backFrame(page, 1_500);
  console.log(`[developer] Longest frame going back after 1500 cards: ${Math.round(frame)} ms, ${(frame / reference).toFixed(1)} times the reference work`);
  // In milliseconds the frame changes with the machine (250 to 850 ms on the same laptop), so it
  // is compared with work of a fixed size. Measured at 4x: 11.2-11.5 times while every card was
  // laid out and redrawn again, 4.7-5.3 while off-screen cards were still laid out, 2.5-2.6 since.
  expect(frame / reference).toBeLessThan(3.8);
});
