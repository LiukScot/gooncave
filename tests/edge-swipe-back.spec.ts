import { expect, test, type Page } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });

async function swipeFromEdge(page: Page, distance: number) {
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, x: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y: 400 }]
    });
  await touch('touchStart', 4);
  for (let x = 4; x <= distance; x += 12) {
    await touch('touchMove', x);
    // slower than a flick, so only the distance decides
    await page.waitForTimeout(40);
  }
  await touch('touchEnd', distance);
}

async function openFirstFile(page: Page) {
  await page.goto('/app/gallery');
  await page.locator('.gallery-thumb').first().click();
  await expect(page).toHaveURL(/fileId=/);
  // the pushed entry is recorded once the URL has been written
  await page.waitForTimeout(500);
}

test('a swipe from the left edge past a third of the width leaves the file', async ({ page }) => {
  await openFirstFile(page);
  await swipeFromEdge(page, 220);
  await expect(page).not.toHaveURL(/fileId=/);
  await expect(page.locator('.gallery-thumb').first()).toBeVisible();
});

test('a file can still be swiped away after a short swipe let it stay', async ({ page }) => {
  await openFirstFile(page);
  const url = page.url();
  await swipeFromEdge(page, 60);
  await page.waitForTimeout(1200);
  expect(page.url()).toBe(url);
  await expect(page.locator('.file-detail-frame')).toBeVisible();
  await swipeFromEdge(page, 220);
  await expect(page).not.toHaveURL(/fileId=/);
});

test('a swipe that starts away from the edge does not leave the file', async ({ page }) => {
  await openFirstFile(page);
  const url = page.url();
  await touchDrag(page, [200, 300], [360, 300]);
  await page.waitForTimeout(600);
  expect(page.url()).toBe(url);
});

async function touchDrag(page: Page, from: [number, number], to: [number, number]) {
  const cdp = await page.context().newCDPSession(page);
  const steps = 12;
  const point = (i: number) => ({
    x: from[0] + ((to[0] - from[0]) * i) / steps,
    y: from[1] + ((to[1] - from[1]) * i) / steps
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(0)] });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(i)] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function openAppearance(page: Page) {
  await page.setViewportSize({ width: 375, height: 420 });
  await page.goto('/app/settings');
  await page.getByRole('link', { name: /appearance/i }).first().click();
  await expect(page).toHaveURL(/settings\/appearance/);
  await page.waitForTimeout(500);
}

test('scrolling a Settings page with a thumb that starts at the edge and drifts sideways still scrolls', async ({ page }) => {
  await openAppearance(page);
  await touchDrag(page, [10, 380], [34, 120]);
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/settings\/appearance/);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(40);
});

test('a Settings page scrolls after a short swipe from the edge let it stay', async ({ page }) => {
  await openAppearance(page);
  await swipeFromEdge(page, 60);
  await page.waitForTimeout(1200);
  await expect(page).toHaveURL(/settings\/appearance/);
  await touchDrag(page, [200, 380], [200, 120]);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(40);
});

test('opening a Settings page slides it in', async ({ page }) => {
  await page.goto('/app/settings');
  await page.waitForTimeout(500);
  // the animation lasts 400ms, so every frame is recorded instead of sampled
  await page.evaluate(() => {
    const seen = new Set<string>();
    (window as unknown as { __animations: Set<string> }).__animations = seen;
    const record = () => {
      for (const animation of document.documentElement.getAnimations({ subtree: true })) {
        seen.add((animation as CSSAnimation).animationName);
      }
      requestAnimationFrame(record);
    };
    record();
  });
  await page.getByRole('link', { name: /appearance/i }).first().click();
  await page.waitForTimeout(800);
  const seen = await page.evaluate(() => [...(window as unknown as { __animations: Set<string> }).__animations]);
  expect(seen).toContain('ios-push-in');
});

test('a swipe from the edge finishes when the touched element leaves the page', async ({ page }) => {
  await page.goto('/app/settings');
  await page.getByRole('link', { name: /appearance/i }).first().click();
  await expect(page).toHaveURL(/settings\/appearance/);
  await page.waitForTimeout(500);
  // The page under the thumb is removed as soon as the swipe goes back, and
  // a touch keeps reporting to the element it started on.
  await page.evaluate(() => {
    const strip = document.createElement('div');
    strip.style.cssText = 'position:fixed;inset:0 auto 0 0;width:24px;z-index:2147483000';
    document.querySelector('.page-chrome')?.appendChild(strip);
  });
  await swipeFromEdge(page, 220);
  await expect(page).toHaveURL(/\/app\/settings\/?$/);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.documentElement.matches(':active-view-transition'))).toBe(false);
  // a new swipe is not refused by a gesture that never ended
  await page.getByRole('link', { name: /appearance/i }).first().click();
  await expect(page).toHaveURL(/settings\/appearance/);
  await page.waitForTimeout(500);
  await swipeFromEdge(page, 220);
  await expect(page).toHaveURL(/\/app\/settings\/?$/);
});

const noActiveTransition = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => document.documentElement.matches(':active-view-transition')))
    .toBe(false);

test('a swipe back that takes the reader out of Settings finishes on release', async ({ page }) => {
  await page.goto('/app/gallery');
  await expect(page.locator('.gallery-thumb').first()).toBeVisible();
  // Reached from outside Settings, so going back unmounts the Settings layout under the finger.
  await page.evaluate(() => window.history.pushState({}, '', '/app/settings/appearance'));
  await expect(page.getByRole('heading', { name: /appearance/i }).first()).toBeVisible();
  await page.waitForTimeout(500);
  await swipeFromEdge(page, 220);
  await expect(page).toHaveURL(/\/app\/gallery/);
  await noActiveTransition(page);
  await page.locator('.gallery-thumb').first().click();
  await expect(page).toHaveURL(/fileId=/);
});

test('a later swipe back still works when a transition never reports its end', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Animation.prototype, 'finished', { get: () => new Promise(() => undefined) });
  });
  await page.goto('/app/settings');
  await page.getByRole('link', { name: /appearance/i }).first().click();
  await expect(page).toHaveURL(/settings\/appearance/);
  await page.waitForTimeout(500);
  await swipeFromEdge(page, 220);
  await expect(page).toHaveURL(/\/app\/settings\/?$/);
  await noActiveTransition(page);
  await page.waitForTimeout(1600);
  await page.getByRole('link', { name: /appearance/i }).first().click();
  await expect(page).toHaveURL(/settings\/appearance/);
  await page.waitForTimeout(500);
  await swipeFromEdge(page, 220);
  await expect(page).toHaveURL(/\/app\/settings\/?$/);
});

test('a picture swipe settles when the touched element leaves the page', async ({ page }) => {
  await openFirstFile(page);
  // The preview becomes the full picture, or a control fades out, while the finger is down.
  await page.evaluate(() => {
    const strip = document.createElement('div');
    strip.id = 'touched';
    strip.style.cssText = 'position:fixed;left:150px;top:200px;width:100px;height:200px;z-index:2147483000';
    document.querySelector('.file-detail-frame')?.appendChild(strip);
  });
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, x: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: 300 }] });
  await touch('touchStart', 200);
  for (let x = 190; x >= 160; x -= 10) await touch('touchMove', x);
  await expect(page.locator('.file-detail-track')).not.toHaveAttribute('style', /\+ 0px/);
  await page.evaluate(() => document.getElementById('touched')?.remove());
  await page.waitForTimeout(300);
  await touch('touchEnd', 160);
  await expect(page.locator('.file-detail-track')).toHaveAttribute('style', /\+ 0px/);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
});

const fixturePost = (id: string, extra: Record<string, unknown> = {}) => ({
  remoteId: id, siteId: 'fixture', siteName: 'Fixture', engine: 'e621',
  previewUrl: '/favicon.png', sampleUrl: null, fileUrl: '/favicon.png',
  width: 640, height: 480, score: 0, rating: null, md5: null, createdAt: null,
  tags: [], favCount: null, uploader: null, fileExt: 'png', fileSize: null,
  favorited: false, voted: null, sourceUrl: `https://fixture.invalid/posts/${id}`,
  parentId: null, hasChildren: false, poolIds: [], ...extra
});

async function mockBooru(page: Page) {
  const related = [
    { ...fixturePost('9'), isParent: true, isCurrent: false, localFileId: null },
    { ...fixturePost('1', { parentId: '9' }), isParent: false, isCurrent: true, localFileId: null }
  ];
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [{
    id: 'fixture', name: 'Fixture', engine: 'e621', baseUrl: 'https://fixture.invalid',
    enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
    engineCredentialSchema: 'username_api_key', sortOrder: 0
  }] } }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: {
    posts: [fixturePost('1', { parentId: '9' }), fixturePost('2')], siteErrors: [], sites: ['fixture']
  } }));
  await page.route(/\/explore\/post(?:-tags|-text|-pools)?\?/, (route) => route.fulfill({ json: {
    post: fixturePost('1'), tags: [], title: null, description: null, parent: null, children: [], pools: []
  } }));
  await page.route('**/explore/post-relations?*', (route) => route.fulfill({ json: { posts: related } }));
  await page.route('**/files/*/relations', (route) => route.fulfill({ json: { posts: related } }));
  await page.route('**/explore/pool?*', (route) => route.fulfill({ json: {
    poolId: '7', siteId: 'fixture', siteName: 'Fixture', name: 'Fixture pool', postCount: 2, page: 1, pageSize: 50,
    posts: [
      { ...fixturePost('1'), localFileId: null, position: 1 },
      { ...fixturePost('2'), localFileId: null, position: 2 }
    ],
    postIds: ['1', '2']
  } }));
}

/** The page it returns to shows under the finger, a short swipe keeps the post, and a long one leaves it. */
async function expectSwipeBackCloses(page: Page, postUrl: RegExp, leavesTo: RegExp) {
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, x: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: 400 }] });
  await touch('touchStart', 4);
  for (let x = 16; x <= 64; x += 12) {
    await touch('touchMove', x);
    await page.waitForTimeout(40);
  }
  await expect(page).toHaveURL(leavesTo);
  await touch('touchEnd', 64);
  await noActiveTransition(page);
  await expect(page).toHaveURL(postUrl);
  await expect(page.locator('.file-detail-panel-current')).toBeVisible();
  await page.waitForTimeout(500);
  await swipeFromEdge(page, 220);
  await expect(page).toHaveURL(leavesTo);
  await noActiveTransition(page);
  await expect(page.locator('.file-detail-panel-current')).toHaveCount(0);
}

test('a swipe back closes a pool page and returns to the pool', async ({ page }) => {
  await mockBooru(page);
  await page.goto('/app/pool?site=fixture&pool=7');
  await page.getByRole('button', { name: /Open page 1 of the pool/ }).click();
  await expect(page.locator('.file-detail-panel-current')).toBeVisible();
  await expectSwipeBackCloses(page, /post=fixture/, /\/app\/pool/);
  await expect(page.getByRole('button', { name: /Open page 1 of the pool/ })).toBeVisible();
});

test('a swipe back closes a related post opened from Explore', async ({ page }) => {
  await mockBooru(page);
  await page.goto('/app/explore');
  await page.getByRole('button', { name: 'Open post 1 from Fixture', exact: false }).click({ position: { x: 8, y: 8 } });
  await page.locator('.file-detail-relation:not(.is-current)').click();
  await expect(page).toHaveURL(/post=fixture(%3A|:)9/);
  await expectSwipeBackCloses(page, /post=fixture(%3A|:)9/, /\/app\/explore(?!.*post=)/);
});

test('a swipe back closes a related post opened from the Gallery', async ({ page }) => {
  await mockBooru(page);
  await openFirstFile(page);
  await page.locator('.file-detail-relation:not(.is-current)').click();
  await expect(page).toHaveURL(/post=fixture(%3A|:)9/);
  await expectSwipeBackCloses(page, /post=fixture(%3A|:)9/, /\/app\/gallery(?!.*fileId=)/);
  await expect(page.locator('.gallery-thumb').first()).toBeVisible();
});

test('a swipe back closes a file opened directly from its link', async ({ page }) => {
  await openFirstFile(page);
  await page.reload();
  await expect(page.locator('.file-detail-panel-current')).toBeVisible();
  await expectSwipeBackCloses(page, /fileId=/, /\/app\/gallery(?!.*fileId=)/);
  await expect(page.locator('.gallery-thumb').first()).toBeVisible();
});

test('a swipe back closes an Explore post opened directly from its link', async ({ page }) => {
  await mockBooru(page);
  await page.goto('/app/explore');
  await page.getByRole('button', { name: 'Open post 1 from Fixture', exact: false }).click({ position: { x: 8, y: 8 } });
  await expect(page).toHaveURL(/post=fixture/);
  await page.reload();
  await expect(page.locator('.file-detail-panel-current')).toBeVisible();
  await expectSwipeBackCloses(page, /post=fixture/, /\/app\/explore(?!.*post=)/);
});

test('a swipe from the edge stays in a fullscreen pool page', async ({ page }) => {
  await mockBooru(page);
  await page.goto('/app/pool?site=fixture&pool=7');
  await page.getByRole('button', { name: /Open page 1 of the pool/ }).click();
  await page.locator('.file-detail-panel-current .file-detail-fullscreen-btn').click();
  await expect(page.locator('.file-detail-media-wrap.is-fullscreen')).toBeVisible();
  await page.waitForTimeout(500);
  await swipeFromEdge(page, 220);
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/post=fixture/);
  await expect(page.locator('.file-detail-media-wrap.is-fullscreen')).toBeVisible();
});
