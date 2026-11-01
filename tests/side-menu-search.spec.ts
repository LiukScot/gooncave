import { expect, test, type Page } from '@playwright/test';

import type { ExplorePost } from '../frontend/src/api';

const LENS = /^Search and filter/;

const site = (id: string, name: string) => ({
  id, name, engine: 'moebooru', baseUrl: `https://${id}.invalid`, username: null, hasApiKey: false,
  hasSessionCookie: false, isPreset: false, presetKey: null, enabled: true, siteAutoSyncMidnight: false,
  siteReverseSyncEnabled: false, siteAutoFavEnabled: false, sortOrder: 0, createdAt: '', updatedAt: '',
  engineCredentialSchema: { fields: [] }, engineSupportsSessionCookie: false, browserSignIn: null
});

const post = (id: string): ExplorePost => ({
  remoteId: id, siteId: 'one', siteName: 'One', engine: 'moebooru',
  previewUrl: '/favicon.png', sampleUrl: '/favicon.png', fileUrl: '/favicon.png',
  width: 100, height: 100, score: null, rating: null, md5: null, createdAt: null,
  tags: [{ tag: 'fixture_tag', category: 'general' }], favCount: null, uploader: null,
  fileExt: 'png', fileSize: null, favorited: false, voted: null,
  sourceUrl: `https://one.invalid/post/show/${id}`, parentId: null, hasChildren: false, poolIds: []
});

async function mockSites(page: Page) {
  await page.route('**/booru-sites', (route) => route.fulfill({
    json: { sites: [site('one', 'One'), site('two', 'Two'), site('three', 'Three')] }
  }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({
    json: { posts: [post('1')], siteErrors: [], sites: ['one', 'two', 'three'] }
  }));
  await page.route('**/settings/subscriptions/tags', (route) => route.fulfill({ json: { tags: ['fixture_tag'] } }));
  await page.route('**/explore/subscriptions?*', (route) => route.fulfill({
    json: { posts: [post('2')], hasMore: false, nextCursor: null, ready: true }
  }));
  await page.route('**/explore/subscriptions/refresh', (route) => route.fulfill({ json: { errors: [] } }));
  await page.route('**/explore/subscriptions/bookmark', (route) => route.fulfill({ json: { ok: true } }));
}

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });

  async function swipeFromEdge(page: Page, distance: number) {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, x: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y: 400 }]
      });
    await touch('touchStart', 4);
    for (let x = 4; x <= distance; x += 12) await touch('touchMove', x);
    await touch('touchEnd', distance);
  }

  test('the Actions heading sits as close to its controls as the other section headings', async ({ page }) => {
    await page.goto('/app/gallery');
    await page.locator('.search-lens').click();
    const panel = page.locator('.search-panel');
    await panel.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    const gapBelow = async (heading: string, controls: string) => {
      const label = await panel.getByRole('heading', { name: heading, exact: true }).boundingBox();
      const control = await panel.getByRole('button', { name: controls, exact: true }).boundingBox();
      return control!.y - (label!.y + label!.height);
    };
    expect(await gapBelow('Actions', 'Downloaded only')).toBeCloseTo(await gapBelow('Show', 'All'), 0);
  });

  test('the menu opens from its button and from the left edge, and moves between views', async ({ page }) => {
    await page.goto('/app/gallery');
    const menu = page.getByRole('navigation', { name: 'Main menu' });
    await expect(menu).toBeHidden();

    await page.getByRole('button', { name: 'Open menu' }).click();
    await menu.getByRole('link', { name: 'Explore' }).click();
    await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
    await expect(menu).toBeHidden();

    await swipeFromEdge(page, 200);
    await expect(menu).toBeVisible();
    await expect.poll(async () => (await page.locator('.app-menu-drawer').boundingBox())?.x).toBe(0);
    await page.getByRole('button', { name: 'Close menu' }).click();
    await expect(menu).toBeHidden();

    // the open view stays where it is, and the drawer gets out of the way
    await page.getByRole('button', { name: 'Open menu' }).click();
    await menu.getByRole('link', { name: 'Explore' }).click();
    await expect(menu).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  });

  test('the open menu pushes the whole page aside, and tapping the page closes it', async ({ page }) => {
    await page.goto('/app/gallery');
    const shell = page.locator('.page-shell');
    const lens = page.locator('.search-lens');
    await expect(lens).toBeVisible();
    // scrolled, so a lens measuring from the page instead of the screen shows
    await shell.evaluate((node) => { node.style.minHeight = '3000px'; });
    await page.evaluate(() => window.scrollTo(0, 1000));
    const lensBefore = (await lens.boundingBox())!;

    await swipeFromEdge(page, 200);
    const width = (await page.locator('.app-menu-drawer').boundingBox())!.width;
    expect(width).toBeLessThan(375);
    await expect.poll(async () => (await shell.boundingBox())?.x).toBeCloseTo(width, 1);
    await expect.poll(async () => (await lens.boundingBox())?.x).toBeCloseTo(lensBefore.x + width, 1);
    expect((await lens.boundingBox())!.y).toBeCloseTo(lensBefore.y, 1);

    await page.mouse.click(width + 40, 400);
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeHidden();
    await expect.poll(async () => (await shell.boundingBox())?.x).toBe(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(1000);
  });

  test('the open menu leaves the media of the cards it pushes off screen', async ({ page }) => {
    await mockSites(page);
    await page.route('**/explore/posts?*', (route) => route.fulfill({
      json: { posts: Array.from({ length: 40 }, (_, index) => post(String(index + 1))), siteErrors: [], sites: ['one'] }
    }));
    await page.goto('/app/explore');
    const cards = page.locator('[data-test-id="explore-card"]');
    await expect(cards.first()).toBeVisible();
    const right = await cards.evaluateAll((all) => all.findIndex((card) => {
      const { left, top } = card.getBoundingClientRect();
      return left > 150 && top < window.innerHeight;
    }));
    expect(right).toBeGreaterThanOrEqual(0);
    const card = cards.nth(right);

    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect.poll(async () => (await card.boundingBox())?.x).toBeGreaterThan(375);
    await page.waitForTimeout(300);
    await expect(card.locator('[data-test-id="explore-card-placeholder"]')).toHaveCount(0);
  });

  // Holds the finger down at `to`, so a test can look mid-gesture; returns the release.
  async function dragTo(page: Page, from: [number, number], to: [number, number]) {
    const cdp = await page.context().newCDPSession(page);
    const send = (type: string, point?: [number, number]) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: point ? [{ x: point[0], y: point[1] }] : []
      });
    await send('touchStart', from);
    const steps = 12;
    for (let step = 1; step <= steps; step += 1) {
      await send('touchMove', [
        from[0] + ((to[0] - from[0]) * step) / steps,
        from[1] + ((to[1] - from[1]) * step) / steps
      ]);
      await page.waitForTimeout(16);
    }
    return () => send('touchEnd');
  }

  test('the menu follows the finger from anywhere on the page, both ways', async ({ page }) => {
    await page.goto('/app/gallery');
    await expect(page.locator('.search-lens')).toBeVisible();
    const shell = page.locator('.page-shell');
    const drawer = page.locator('.app-menu-drawer');

    // part of the way, still held: the page sits under the finger
    let release = await dragTo(page, [100, 500], [180, 500]);
    expect((await shell.boundingBox())!.x).toBeGreaterThan(50);
    expect((await shell.boundingBox())!.x).toBeLessThan(90);
    const held = (await drawer.boundingBox())!;
    expect(held.x).toBeCloseTo((await shell.boundingBox())!.x - held.width, 0);
    // moving back moves it back
    await release();
    await expect(drawer).toHaveCount(0);
    await expect.poll(async () => (await shell.boundingBox())?.x).toBe(0);

    release = await dragTo(page, [60, 500], [300, 500]);
    await release();
    await expect.poll(async () => (await drawer.boundingBox())?.x).toBeCloseTo(0, 1);
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();

    // closing starts on the page beside the menu or on the menu alike
    release = await dragTo(page, [340, 300], [260, 300]);
    expect((await drawer.boundingBox())!.x).toBeLessThan(-50);
    await release();
    await expect.poll(async () => (await drawer.boundingBox())?.x).toBeCloseTo(0, 1);
    release = await dragTo(page, [230, 300], [20, 300]);
    await release();
    await expect(drawer).toHaveCount(0);
    await expect.poll(async () => (await shell.boundingBox())?.x).toBe(0);
  });

  test('a second finger neither stops the drag nor leaves the menu stuck', async ({ page }) => {
    await page.goto('/app/gallery');
    await expect(page.locator('.search-lens')).toBeVisible();
    const shell = page.locator('.page-shell');
    const drawer = page.locator('.app-menu-drawer');
    const cdp = await page.context().newCDPSession(page);
    const send = (type: string, ...points: [number, number, number][]) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map(([id, x, y]) => ({ id, x, y }))
      });

    await send('touchStart', [1, 60, 500]);
    await send('touchMove', [1, 100, 500]);
    await send('touchMove', [1, 140, 500]);
    await send('touchStart', [1, 140, 500], [2, 300, 200]);
    await send('touchMove', [1, 300, 500], [2, 300, 200]);
    await expect.poll(async () => (await shell.boundingBox())?.x).toBeGreaterThan(150);
    // the other finger lifts: the first still holds it
    await send('touchMove', [1, 300, 500]);
    expect((await shell.boundingBox())!.x).toBeGreaterThan(150);
    await send('touchEnd');
    await expect.poll(async () => (await drawer.boundingBox())?.x).toBeCloseTo(0, 1);

    await page.locator('.app-menu-close').click();
    await expect(drawer).toHaveCount(0);
  });

  test('a finger catches the menu while it glides shut', async ({ page }) => {
    await page.goto('/app/gallery');
    await expect(page.locator('.search-lens')).toBeVisible();
    const drawer = page.locator('.app-menu-drawer');
    let release = await dragTo(page, [60, 500], [300, 500]);
    await release();
    await expect.poll(async () => (await drawer.boundingBox())?.x).toBeCloseTo(0, 1);

    release = await dragTo(page, [240, 300], [40, 300]);
    await release();
    release = await dragTo(page, [40, 300], [300, 300]);
    await release();
    await expect.poll(async () => (await drawer.boundingBox())?.x).toBeCloseTo(0, 1);
  });

  test('scrolling the page does not open the menu', async ({ page }) => {
    await page.goto('/app/gallery');
    await expect(page.locator('.search-lens')).toBeVisible();
    const release = await dragTo(page, [150, 600], [190, 300]);
    await release();
    await expect(page.locator('.app-menu-drawer')).toHaveCount(0);
  });

  test('the panel rises with a drag on the lens and closes with a drag down from anywhere', async ({ page }) => {
    await page.goto('/app/gallery');
    const lens = page.locator('.search-lens');
    await expect(lens).toBeVisible();
    const box = (await lens.boundingBox())!;
    const panel = page.locator('.search-panel');
    const start: [number, number] = [box.x + box.width / 2, box.y + box.height / 2];

    let release = await dragTo(page, start, [start[0], start[1] - 80]);
    const risen = (await panel.boundingBox())!;
    expect(risen.y).toBeGreaterThan(812 - risen.height);
    expect(risen.y).toBeLessThan(812 - 40);
    // too short to commit: it goes back down
    await release();
    await expect(panel).toHaveCount(0);

    release = await dragTo(page, start, [start[0], start[1] - 300]);
    await release();
    await expect.poll(async () => (await panel.boundingBox())?.y).toBeCloseTo(812 - risen.height, 0);

    // a short drag from inside it follows and returns
    release = await dragTo(page, [100, 812 - risen.height + 40], [100, 812 - risen.height + 80]);
    expect((await panel.boundingBox())!.y).toBeGreaterThan(812 - risen.height + 20);
    await release();
    await expect.poll(async () => (await panel.boundingBox())?.y).toBeCloseTo(812 - risen.height, 0);

    // from the page above it, far enough to close
    release = await dragTo(page, [100, 100], [100, 500]);
    await release();
    await expect(panel).toHaveCount(0);
  });

  test('on a phone the menu curves the page like the screen, and without one the default', async ({ page }) => {
    const corner = () => page.locator('.app-menu-drawer').evaluate((node) => getComputedStyle(node, '::before').width);
    await page.goto('/app/gallery');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect.poll(corner).toBe('24px');

    await page.addInitScript(() => {
      (window as { gooncaveScreenCorner?: number }).gooncaveScreenCorner = 47;
    });
    await page.goto('/app/gallery');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect.poll(corner).toBe('47px');
  });

  test('the edge line of the menu is as bright around its curved corners as along its side', async ({ page }) => {
    await page.addInitScript(() => {
      (window as { gooncaveScreenCorner?: number }).gooncaveScreenCorner = 47;
    });
    await page.goto('/app/gallery');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect.poll(async () => (await page.locator('.app-menu-drawer').boundingBox())?.x).toBeCloseTo(0, 1);
    await expect.poll(() => page.locator('.app-menu-drawer').evaluate((node) => node.getAnimations().length)).toBe(0);

    const shot = (await page.screenshot()).toString('base64');
    const brightest = await page.evaluate(async (png) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const peak = (y: number) => {
        const row = context.getImageData(240, y, 40, 1).data;
        let top = 0;
        for (let at = 0; at < row.length; at += 4) top = Math.max(top, row[at]);
        return top;
      };
      return { side: peak(400), top: peak(30), bottom: peak(image.height - 31) };
    }, shot);
    expect(brightest.top).toBeGreaterThan(brightest.side * 0.7);
    expect(brightest.bottom).toBeGreaterThan(brightest.side * 0.7);
  });

  test('the panel names its actions and its search, with Reset all beside the actions', async ({ page }) => {
    await page.goto('/app/gallery');
    await page.getByRole('button', { name: LENS }).click();
    const panel = page.getByRole('dialog', { name: LENS });
    await panel.getByRole('button', { name: 'Photos', exact: true }).click();
    const actions = (await panel.getByRole('heading', { name: 'Actions' }).boundingBox())!;
    const reset = (await panel.getByRole('button', { name: /Reset all/ }).boundingBox())!;
    expect(Math.abs(reset.y + reset.height / 2 - (actions.y + actions.height / 2))).toBeLessThan(4);
    expect(reset.x).toBeGreaterThan(actions.x + actions.width);
    await expect(panel.getByRole('heading', { name: 'Search', exact: true })).toBeVisible();
  });

  test('a swipe from the edge leaves an open panel alone', async ({ page }) => {
    await page.goto('/app/gallery');
    await page.getByRole('button', { name: LENS }).click();
    await expect(page.getByRole('dialog', { name: LENS })).toBeVisible();
    await swipeFromEdge(page, 200);
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeHidden();
  });

  test('a swipe from the edge opens the menu on Games too', async ({ page }) => {
    await page.goto('/app/games');
    await expect(page.getByRole('heading', { name: 'Games', exact: true })).toBeVisible();
    await swipeFromEdge(page, 200);
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();
  });

  test('moving between the views of the menu changes the page at once, without a slide', async ({ page }) => {
    await page.goto('/app/gallery');
    await page.evaluate(() => {
      const state = { transitions: 0 };
      (window as unknown as { __page: typeof state }).__page = state;
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = ((update: never) => {
        state.transitions += 1;
        return start(update);
      }) as typeof document.startViewTransition;
    });
    for (const name of ['Subscriptions', 'History', 'Explore']) {
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.getByRole('navigation', { name: 'Main menu' }).getByRole('link', { name }).click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => (window as unknown as { __page: { transitions: number } }).__page.transitions)).toBe(0);

    await expect(page.locator('.app-menu-drawer')).toHaveCount(0);
    await page.getByRole('button', { name: LENS }).click();
    await expect(page.getByRole('dialog', { name: LENS })).toBeVisible();
  });

  for (const [view, path] of [['Explore', '/app/explore'], ['Gallery', '/app/gallery']]) {
    test(`a ${view} tile holds a surface until its picture has arrived, then fades it in`, async ({ page }) => {
      await mockSites(page);
      const held: (() => Promise<void>)[] = [];
      await page.route('**/*', async (route) => {
        if (route.request().resourceType() !== 'image' || !/favicon\.png|thumb|file/i.test(route.request().url())) {
          return route.fallback();
        }
        await new Promise<void>((release) => held.push(async () => release()));
        return route.fallback();
      });
      await page.goto(path);
      const image = page.locator('.gallery-thumb-img').first();
      await expect(image).toBeAttached();
      await expect.poll(() => held.length).toBeGreaterThan(0);

      const look = () => image.evaluate((element) => ({
        opacity: getComputedStyle(element).opacity,
        surface: getComputedStyle(element.closest('.gallery-thumb')!).backgroundColor
      }));
      const waiting = await look();
      expect(waiting.opacity).toBe('0');
      expect(waiting.surface).not.toBe('rgba(0, 0, 0, 0)');

      await page.unroute('**/*');
      for (const release of held.splice(0)) await release();
      await expect.poll(look).toEqual({ opacity: '1', surface: 'rgba(0, 0, 0, 0)' });
    });
  }

  test('a Gallery thumbnail that fails to load stays visible, showing its name', async ({ page }) => {
    await page.route('**/*', (route) =>
      route.request().resourceType() === 'image' && /thumb|file/i.test(route.request().url())
        ? route.abort()
        : route.fallback());
    await page.goto('/app/gallery');
    await expect(page.locator('.gallery-thumb-img').first()).toHaveCSS('opacity', '1');
  });

  test('the title hides while scrolling down and returns on scrolling up, without moving the page', async ({ page }) => {
    await mockSites(page);
    await page.route('**/explore/posts?*', (route) => route.fulfill({
      json: { posts: Array.from({ length: 40 }, (_, index) => post(String(index + 1))), siteErrors: [], sites: ['one'] }
    }));
    await page.goto('/app/explore');
    const title = page.locator('.page-header');
    const card = page.locator('.gallery-masonry a, .gallery-masonry button').first();
    await expect(title).toBeInViewport();
    await expect(card).toBeVisible();

    const scrollTo = (y: number) => page.evaluate((top) => window.scrollTo(0, top), y);
    const topOfPage = async () => (await card.boundingBox())!.y + (await page.evaluate(() => window.scrollY));
    const before = await topOfPage();

    await scrollTo(600);
    await expect(title).not.toBeInViewport();
    expect(await topOfPage()).toBeCloseTo(before, 0);

    await scrollTo(500);
    await expect(title).toBeInViewport();
    await expect.poll(async () => (await title.boundingBox())!.y).toBe(0);
    expect(await topOfPage()).toBeCloseTo(before, 0);

    await scrollTo(800);
    await expect(title).not.toBeInViewport();
    await scrollTo(0);
    await expect(title).toBeInViewport();
  });

  test('the edge goes back on a Settings page instead of opening the menu', async ({ page }) => {
    await page.goto('/app/settings');
    await page.getByRole('link', { name: /appearance/i }).first().click();
    await expect(page).toHaveURL(/settings\/appearance/);
    await page.waitForTimeout(500);
    await swipeFromEdge(page, 220);
    await expect(page).toHaveURL(/\/app\/settings\/?$/);
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeHidden();
  });

  test('choices apply at once, show as chips and on the lens, and reset together', async ({ page }) => {
    await page.goto('/app/gallery');
    const landscape = page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]');
    await expect(landscape).toBeVisible();

    const lens = page.getByRole('button', { name: LENS });
    // the default order shows as a chip that opens the panel and has nothing to remove
    await expect(page.locator('.active-filter')).toHaveText(['Order: Newest']);
    await expect(page.locator('.active-filter-clear')).toHaveCount(0);
    await expect(page.locator('.search-lens-badge')).toHaveCount(0);
    await page.getByRole('button', { name: 'Order: Newest', exact: true }).click();
    await expect(page.getByRole('dialog', { name: LENS })).toBeVisible();
    await page.keyboard.press('Escape');
    await lens.click();

    const panel = page.getByRole('dialog', { name: LENS });
    // the keyboard stays down until the reader asks for the field
    await expect(panel.locator('input')).not.toBeFocused();
    for (const button of await panel.locator('.btn-group .btn').all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    await panel.getByRole('button', { name: 'Videos', exact: true }).click();
    await expect(landscape).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.getByRole('button', { name: 'Videos only', exact: true })).toBeVisible();
    await expect(page.locator('.search-lens-badge')).toHaveText('1');

    // one filter is removed from its chip; the chip's name reopens the panel
    await page.getByRole('button', { name: 'Remove Videos only' }).click();
    await expect(landscape).toBeVisible();
    await lens.click();
    await panel.getByRole('button', { name: 'Photos', exact: true }).click();
    await panel.getByRole('button', { name: 'Oldest', exact: true }).click();
    await expect(landscape).toBeVisible();
    await expect(page.locator('.search-lens-badge')).toHaveText('2');
    await panel.getByRole('button', { name: 'Reset all (2)' }).click();
    await expect(page.locator('.active-filter')).toHaveText(['Order: Newest']);
    await expect(page.locator('.active-filter-clear')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Newest', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  });

  test('each searched tag has its own chip, and the lens stays an icon', async ({ page }) => {
    await page.goto('/app/gallery');
    const lens = page.getByRole('button', { name: LENS });
    await lens.click();
    const panel = page.getByRole('dialog', { name: LENS });
    const field = panel.locator('input');
    await field.fill('first_tag second_tag');
    await page.keyboard.press('Escape');

    await expect(page.locator('.active-filter-clear')).toHaveCount(2);
    await expect(page.locator('.search-lens-badge')).toHaveText('2');
    await expect(lens).not.toContainText('first_tag');

    await page.getByRole('button', { name: 'Remove first_tag' }).click();
    await expect(page.locator('.active-filter-clear')).toHaveCount(1);
    await lens.click();
    await expect(field).toHaveValue('second_tag');

    await field.fill('first_tag second_tag');
    await panel.getByRole('button', { name: 'Reset all (2)' }).click();
    await expect(field).toHaveValue('');
  });

  test('a long search does not push the lens or the chips off the screen', async ({ page }) => {
    await page.goto('/app/gallery');
    await page.getByRole('button', { name: LENS }).click();
    const panel = page.getByRole('dialog', { name: LENS });
    await panel.locator('input').fill('a_very_long_tag_name_that_goes_on_and_on_for_longer_than_any_phone_is_wide');
    await panel.getByRole('button', { name: 'Close panel' }).click();
    await expect(panel).toBeHidden();
    const lens = await page.getByRole('button', { name: LENS }).boundingBox();
    expect(lens!.x).toBeGreaterThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  });

  test('a site in the panel shows its logo whether on or off, and Unread only its icon', async ({ page }) => {
    await page.route('**/booru-sites', (route) => route.fulfill({
      json: { sites: [{ ...site('one', 'One'), baseUrl: 'https://e621.net' }] }
    }));
    await page.goto('/app/explore');
    await page.getByRole('button', { name: LENS }).click();
    const panel = page.getByRole('dialog', { name: LENS });
    const pill = panel.getByRole('button', { name: 'One', exact: true });
    await expect(pill.locator('img')).toHaveAttribute('src', '/site-logos/e621.svg');
    await expect(pill.locator('.lucide-check')).toHaveCount(0);
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'false');
    await expect(pill.locator('img')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Unread only' }).locator('svg')).toBeVisible();
  });

  test('Explore narrows to some sites and its Score window, with the feeds as pages of their own', async ({ page }) => {
    await mockSites(page);
    await page.goto('/app/explore');
    await page.getByRole('button', { name: LENS }).click();
    const panel = page.getByRole('dialog', { name: LENS });
    await panel.getByRole('button', { name: 'Two', exact: true }).click();
    await expect(panel.getByText('2 of 3')).toBeVisible();
    await panel.getByRole('button', { name: 'Score', exact: true }).click();
    await panel.getByRole('group', { name: 'Score time window' }).getByRole('button', { name: 'Week' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '2 of 3 sites', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Order: Score · week', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('navigation', { name: 'Main menu' }).getByRole('link', { name: 'Subscriptions' }).click();
    await expect(page.getByRole('heading', { name: 'Subscriptions', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manage subscriptions' })).toBeVisible();
    await expect(page.locator('[data-read-key="one:2"]')).toBeVisible();

    await page.getByRole('button', { name: /^Filter this feed/ }).click();
    const feedPanel = page.getByRole('dialog', { name: 'Filter this feed' });
    await expect(feedPanel.locator('input[type="search"], input[type="text"]')).toHaveCount(0);
    await expect(feedPanel.getByRole('button', { name: 'Hot', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // an open post keeps its feed behind it
    await page.locator('[data-read-key="one:2"]').click();
    await expect(page).toHaveURL(/feed=subscribed/);
    await expect(page).toHaveURL(/post=/);
    await page.goBack();
    await expect(page).toHaveURL(/feed=subscribed$/);
    await expect(page.getByRole('heading', { name: 'Subscriptions', exact: true })).toBeVisible();

    // Back returns to Explore, with its order where it was left
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Order: Score · week', exact: true })).toBeVisible();
  });

  test('searching a tag from a post far down a feed starts at the top of the results', async ({ page }) => {
    await mockSites(page);
    await page.route(/\/explore\/post(?:-tags|-text|-relations|-pools)?\?/, (route) => route.fulfill({ json: {
      post: post('159'), tags: post('159').tags, title: null, description: null, parent: null, children: [], pools: []
    } }));
    const posts = (prefix: number, count: number) =>
      Array.from({ length: count }, (_, index) => post(String(prefix + index)));
    await page.route('**/explore/subscriptions?*', (route) => route.fulfill({
      json: { posts: posts(100, 60), hasMore: false, nextCursor: null, ready: true }
    }));
    // Taller than the window, and much shorter than where the feed was scrolled to.
    await page.route('**/explore/posts?*', (route) => route.fulfill({
      json: { posts: posts(500, 30), siteErrors: [], sites: ['one', 'two', 'three'] }
    }));
    await page.goto('/app/explore?feed=subscribed');
    const cards = page.locator('[data-test-id="explore-card"]');
    await expect(cards.first()).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    await page.locator('[data-read-key="one:159"]').click();
    await page.locator('.file-detail-panel-current .file-tag-pill', { hasText: 'fixture_tag' }).locator('button').first().click();
    await page.getByRole('button', { name: 'Search tag' }).click();

    await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
    await expect(cards.first()).toBeVisible();
    // The restore runs for a while after the list appears, so a single read could pass too early.
    await page.waitForTimeout(1_000);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('searching a tag from a feed post shows the results in Explore', async ({ page }) => {
    await mockSites(page);
    await page.route(/\/explore\/post(?:-tags|-text|-relations|-pools)?\?/, (route) => route.fulfill({ json: {
      post: post('2'), tags: post('2').tags, title: null, description: null, parent: null, children: [], pools: []
    } }));
    await page.goto('/app/explore?feed=subscribed');
    await page.locator('[data-read-key="one:2"]').click();
    await page.locator('.file-detail-panel-current .file-tag-pill', { hasText: 'fixture_tag' }).locator('button').first().click();
    await page.getByRole('button', { name: 'Search tag' }).click();
    await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/feed=/);
    await expect(page.getByRole('button', { name: 'fixture_tag', exact: true })).toBeVisible();
  });

  test('History has no filters, and says how to turn it on when it is off', async ({ page }) => {
    const settings = await (await page.request.get('/settings/extra')).json();
    await page.route('**/settings/extra', (route) => route.fulfill({ json: { ...settings, readTrackingEnabled: false } }));
    // Turning History off deletes its marks, but specs that ran earlier on this database left some.
    await page.route('**/read-marks/history?*', (route) => route.fulfill({ json: { posts: [], nextCursor: null } }));
    await page.goto('/app/explore?feed=history');
    await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
    await expect(page.locator('.search-lens')).toHaveCount(0);
    await page.getByRole('link', { name: 'Turn on History in Extra' }).click();
    await expect(page).toHaveURL(/settings\/extra/);
  });

  test('the sites switched off in Explore still show in History', async ({ page }) => {
    await mockSites(page);
    const askedFor: string[] = [];
    await page.route('**/read-marks/history?*', (route) => {
      askedFor.push(new URL(route.request().url()).searchParams.get('sites') ?? '');
      return route.fulfill({ json: { posts: [], nextCursor: null } });
    });
    await page.goto('/app/explore');
    await page.getByRole('button', { name: LENS }).click();
    await page.getByRole('dialog', { name: LENS }).getByRole('button', { name: 'Two', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('navigation', { name: 'Main menu' }).getByRole('link', { name: 'History' }).click();
    await expect.poll(() => askedFor.at(-1)).toBe('one,two,three');
  });

  test('Subscriptions emptied by the site filter offers to clear it', async ({ page }) => {
    await mockSites(page);
    await page.goto('/app/explore?feed=subscribed');
    await expect(page.locator('[data-read-key="one:2"]')).toBeVisible();
    await page.getByRole('button', { name: /^Filter this feed/ }).click();
    const panel = page.getByRole('dialog', { name: 'Filter this feed' });
    for (const name of ['One', 'Two', 'Three']) {
      await panel.getByRole('button', { name, exact: true }).click();
    }
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.locator('[data-read-key="one:2"]')).toBeVisible();
  });
});

test.describe('with a mouse', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Settings in the menu goes back to the list from one of its pages', async ({ page }) => {
    await page.goto('/app/settings/appearance');
    const menu = page.getByRole('navigation', { name: 'Main menu' });
    await menu.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/app\/settings\/?$/);
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  });

  test('a tile reached with the keyboard is not left under the pinned title', async ({ page }) => {
    await mockSites(page);
    await page.route('**/explore/posts?*', (route) => route.fulfill({
      json: { posts: Array.from({ length: 40 }, (_, index) => post(String(index + 1))), siteErrors: [], sites: ['one'] }
    }));
    await page.goto('/app/explore');
    const tiles = page.locator('[data-test-id="explore-card"]');
    const tile = tiles.nth(12);
    await expect(tile).toBeAttached();
    // scrolling up brings the title back, right over the top of this tile
    const tileTop = await tile.evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
    await page.evaluate((top) => window.scrollTo(0, top + 300), tileTop);
    await page.waitForTimeout(100);
    await page.evaluate((top) => window.scrollTo(0, top - 10), tileTop);
    const title = page.locator('.page-header');
    await expect.poll(async () => (await title.boundingBox())!.y).toBe(0);

    await tile.focus();
    await expect.poll(async () => {
      const titleBox = (await title.boundingBox())!;
      return (await tile.boundingBox())!.y >= titleBox.y + titleBox.height;
    }).toBe(true);
  });

  test('the corners of the lens and of a pressed button change without flashing square', async ({ page }) => {
    await page.goto('/app/gallery');
    const lens = page.locator('.search-lens');
    await expect(lens).toBeVisible();

    const smallestRadiusDuring = async (selector: string, act: () => Promise<void>) => {
      await page.evaluate((target) => {
        const state = { smallest: Infinity, running: true };
        (window as unknown as { radius: typeof state }).radius = state;
        const sample = () => {
          const radius = parseFloat(getComputedStyle(document.querySelector(target)!).borderTopLeftRadius);
          state.smallest = Math.min(state.smallest, radius);
          if (state.running) requestAnimationFrame(sample);
        };
        sample();
      }, selector);
      await act();
      await page.waitForTimeout(450);
      return page.evaluate(() => {
        const state = (window as unknown as { radius: { smallest: number; running: boolean } }).radius;
        state.running = false;
        return state.smallest;
      });
    };

    expect(await smallestRadiusDuring('.search-lens', () => lens.hover())).toBeGreaterThan(10);

    await page.mouse.move(0, 0);
    await lens.click();
    const choice = page.locator('.search-panel .btn').first();
    await choice.hover();
    expect(await smallestRadiusDuring('.search-panel .btn', () => page.mouse.down())).toBeGreaterThan(5);
    await page.mouse.up();
  });

  test('the menu stays showing with the page beside it, and the panel sits over the lens', async ({ page }) => {
    await page.goto('/app/gallery');
    const menu = page.getByRole('navigation', { name: 'Main menu' });
    await expect(menu).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();
    await expect(menu.getByRole('link', { name: 'Gallery' })).toHaveAttribute('aria-current', 'page');
    const menuBox = await page.locator('.app-menu').boundingBox();
    expect(menuBox!.width).toBe(248);
    const title = await page.getByRole('heading', { name: 'Gallery', exact: true }).boundingBox();
    expect(title!.x).toBeGreaterThanOrEqual(248);

    // the lens wears the accent, like the open view in the menu
    const accent = await menu.getByRole('link', { name: 'Gallery' }).evaluate((link) => getComputedStyle(link).backgroundColor);
    await expect(page.getByRole('button', { name: LENS })).toHaveCSS('background-color', accent);

    await page.getByRole('button', { name: LENS }).click();
    const panel = page.getByRole('dialog', { name: LENS });
    const box = await panel.boundingBox();
    expect(box!.width).toBe(540);
    expect(box!.x + box!.width).toBe(1280 - 24);
    await expect(panel.locator('input')).toBeFocused();

    // the page shows through and a click on it closes the panel
    await page.mouse.click(600, 80);
    await expect(panel).toBeHidden();
  });

  test('the keyboard reaches the panel, stays in it and returns to the lens', async ({ page }) => {
    await page.goto('/app/gallery');
    const lens = page.getByRole('button', { name: LENS });
    await expect(page.locator('[data-test-id="file-card"]').first()).toBeVisible();
    // ahead of the tiles, or a library that keeps loading would never reach it
    expect(await lens.evaluate((element) => Boolean(
      element.compareDocumentPosition(document.querySelector('[data-test-id="file-card"]')!) & Node.DOCUMENT_POSITION_FOLLOWING
    ))).toBe(true);
    await lens.focus();
    await page.keyboard.press('Enter');
    const panel = page.getByRole('dialog', { name: LENS });
    await expect(panel).toBeVisible();
    for (let step = 0; step < 15; step += 1) {
      await page.keyboard.press('Tab');
      expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(lens).toBeFocused();
  });

  test('an open file hides the menu and the lens', async ({ page }) => {
    await page.goto('/app/gallery');
    await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').click();
    await expect(page.locator('.file-detail-panel-current')).toBeVisible();
    await expect(page.locator('.app-menu')).toBeHidden();
    await expect(page.locator('.search-lens')).toBeHidden();
  });
});
