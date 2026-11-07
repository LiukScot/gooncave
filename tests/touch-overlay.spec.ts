import { expect, test, type Page } from '@playwright/test';

import type { ExplorePost } from '../frontend/src/api';

import { videoFixture } from './helpers';

const PHONE = {
  hasTouch: true,
  isMobile: true,
  viewport: { width: 375, height: 812 },
  launchOptions: {
    args: ['--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2']
  }
};


/** `video` true, or the size of the video to serve (the posts still say 640×480). */
async function openExplore(page: Page, video: boolean | string = false, description: string | null = null) {
  const posts: ExplorePost[] = ['1', '2'].map((id) => ({
    remoteId: id, siteId: 'fixture', siteName: 'Fixture', engine: 'e621',
    previewUrl: '/favicon.png', sampleUrl: null,
    fileUrl: video ? `${new URL(page.url()).origin}/overlay-fixture.mp4` : '/favicon.png',
    width: 640, height: 480, score: 0, rating: null, md5: null, createdAt: null,
    tags: [{ tag: 'fixture_artist', category: 'artist' }], favCount: null, uploader: null,
    fileExt: video ? 'mp4' : 'png', fileSize: null, favorited: false, voted: null,
    sourceUrl: `https://fixture.invalid/posts/${id}`, parentId: null, hasChildren: false, poolIds: []
  }));
  if (video) {
    const clip = videoFixture(typeof video === 'string' ? video : undefined);
    await page.route('**/overlay-fixture.mp4', (route) => route.fulfill({ contentType: 'video/mp4', body: clip }));
  }
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [{
    id: 'fixture', name: 'Fixture', engine: 'e621', baseUrl: 'https://fixture.invalid',
    enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
    engineCredentialSchema: 'username_api_key', sortOrder: 0
  }] } }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: { posts, siteErrors: [], sites: ['fixture'] } }));
  await page.route(/\/explore\/post(?:-tags|-text|-relations|-pools)?\?/, (route) => route.fulfill({ json: {
    post: posts[0], tags: posts[0].tags, title: null, description, parent: null, children: [], pools: []
  } }));
  await page.goto('/app/explore');
  await page.getByRole('button', { name: 'Open post 1 from Fixture', exact: false }).click({ position: { x: 8, y: 8 } });
  await expect(page.locator('.file-detail-panel-current')).toBeVisible();
}

async function swipeNext(page: Page, on = page.locator('.file-detail-panel-current .file-detail-media')) {
  const media = await on.boundingBox();
  if (!media) throw new Error('No media to swipe');
  const y = media.y + media.height / 2;
  const width = page.viewportSize()?.width ?? media.width;
  const right = Math.min(media.x + media.width * 0.85, width - 20);
  const left = Math.max(media.x + media.width * 0.15, 20);
  const input = await page.context().newCDPSession(page);
  try {
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: right, y }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: (left + right) / 2, y }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: left, y }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await input.detach();
  }
}

test.use({ launchOptions: PHONE.launchOptions });

test.describe('phone media controls', () => {
  test.use({ hasTouch: PHONE.hasTouch, isMobile: PHONE.isMobile, viewport: PHONE.viewport });

  test('the fullscreen button stays shown and tappable after the other controls fade', async ({ page }) => {
    await page.goto('/app/gallery');
    await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').tap();
    const button = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.install();
    await page.clock.fastForward(4_250);
    await expect(button).toHaveCSS('opacity', '1');
    await expect(button).toHaveCSS('pointer-events', 'auto');
    await button.tap({ trial: true });
  });

  test('dragging the picture down from the top opens fullscreen, and a drag up or down leaves it', async ({ page }) => {
    await page.goto('/app/gallery');
    await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').tap();
    const frame = page.locator('.file-detail-frame');
    const wrap = page.locator('.file-detail-panel-current .file-detail-media-wrap');
    await expect(wrap.locator('img')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    const input = await page.context().newCDPSession(page);
    const drag = async (distance: number) => {
      const box = await wrap.boundingBox();
      if (!box) throw new Error('No picture to drag');
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 10; step += 1) {
        await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (distance * step) / 10 }] });
      }
      // The picture follows the finger before the release decides.
      const moved = await wrap.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m42);
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      return moved;
    };
    // The page takes touches again once the fullscreen animation has run.
    const settled = () => expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    try {
      // What follows the picture on the page, like the related posts, stays under it during the drag.
      await wrap.evaluate((element) => {
        const below = document.createElement('div');
        below.className = 'drag-test-below';
        below.style.cssText = 'position:relative;height:400px;background:red';
        element.parentElement!.querySelector('.file-detail-body')!.prepend(below);
      });
      const box = (await wrap.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 10; step += 1) {
        await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 20 * step }] });
      }
      await expect
        .poll(() => wrap.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).m42))
        .toBeGreaterThan(60);
      const covered = await page.evaluate(
        ([px, py]) => document.elementFromPoint(px, py)?.closest('.drag-test-below') !== null,
        [x, box.y + box.height + 40]
      );
      await input.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      await page.evaluate(() => document.querySelector('.drag-test-below')?.remove());
      expect(covered).toBe(false);
      await settled();
      expect(await drag(200)).toBeGreaterThan(50);
      await expect(frame).toHaveClass(/is-fullscreen/);
      await settled();
      // Left another way, the picture is back in its place, not where the drag let go.
      await page.keyboard.press('Escape');
      await expect(frame).not.toHaveClass(/is-fullscreen/);
      await settled();
      await expect(wrap).toHaveCSS('transform', 'none');
      await drag(200);
      await expect(frame).toHaveClass(/is-fullscreen/);
      await settled();
      expect(await drag(-200)).toBeLessThan(-50);
      await expect(frame).not.toHaveClass(/is-fullscreen/);
      await settled();
      await drag(200);
      await expect(frame).toHaveClass(/is-fullscreen/);
      await settled();
      await drag(200);
      await expect(frame).not.toHaveClass(/is-fullscreen/);
      await settled();
      // Further down the page, the same drag scrolls instead.
      // A file with few tags fits the screen. The body's height is the screen's, so padding would
      // not lengthen the page: a block after it does, whatever the data.
      await page.evaluate(() => {
        const room = document.createElement('div');
        room.style.height = '100vh';
        document.body.append(room);
        window.scrollTo(0, 40);
      });
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      await drag(200);
      await expect(frame).not.toHaveClass(/is-fullscreen/);
    } finally {
      await input.detach();
    }
  });

  test('a double tap on the picture enters fullscreen, and with Double tap in fullscreen set to Leave another leaves it', async ({ page }) => {
    // Only this page sees the setting: the database is shared with tests running alongside.
    await page.route('**/settings/extra', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), doubleTap: 'exit' } });
    });
    await page.goto('/app/gallery');
    await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').tap();
    const frame = page.locator('.file-detail-frame');
    const picture = page.locator('.file-detail-panel-current img.file-detail-media');
    await expect(picture).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    const doubleTap = async () => {
      const box = await picture.boundingBox();
      if (!box) throw new Error('No picture to tap');
      await picture.dispatchEvent('dblclick', { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
    };
    await doubleTap();
    await expect(frame).toHaveClass(/is-fullscreen/);
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    await doubleTap();
    await expect(frame).not.toHaveClass(/is-fullscreen/);

    // Two real taps, with the dblclick Chromium makes of them dropped: iOS does not reliably send one.
    await page.evaluate(() => window.addEventListener('dblclick', (event) => event.stopPropagation(), true));
    const tapTwice = async () => {
      const box = await picture.boundingBox();
      if (!box) throw new Error('No picture to tap');
      const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
      await page.touchscreen.tap(x, y);
      await page.touchscreen.tap(x, y);
    };
    // A tap during the view transition lands on the page, not the picture.
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    await tapTwice();
    await expect(frame).toHaveClass(/is-fullscreen/);
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    await tapTwice();
    await expect(frame).not.toHaveClass(/is-fullscreen/);
  });

  test('with Double tap in fullscreen set to Zoom, a double tap enters fullscreen, the next zooms on the tapped spot and a third zooms back out', async ({ page }) => {
    // Only this page sees the setting: the database is shared with tests running alongside.
    await page.route('**/settings/extra', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), doubleTap: 'zoom' } });
    });
    await page.goto('/app/gallery');
    await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').tap();
    const frame = page.locator('.file-detail-frame');
    const wrap = page.locator('.file-detail-panel-current .file-detail-media-wrap');
    const picture = page.locator('.file-detail-panel-current img.file-detail-media');
    await expect(picture).toBeVisible();
    const settled = () => expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    await settled();
    // Real taps, with Chromium's dblclick dropped: iOS does not reliably send one.
    await page.evaluate(() => window.addEventListener('dblclick', (event) => event.stopPropagation(), true));
    const tapTwice = async (x: number, y: number) => {
      await page.touchscreen.tap(x, y);
      await page.touchscreen.tap(x, y);
    };
    const before = (await picture.boundingBox())!;
    await tapTwice(before.x + before.width / 2, before.y + before.height / 2);
    await expect(frame).toHaveClass(/is-fullscreen/);
    await settled();
    await expect(wrap).not.toHaveClass(/is-zoomed/);

    const box = (await picture.boundingBox())!;
    await tapTwice(box.x + box.width * 0.75, box.y + box.height / 2);
    await expect(wrap).toHaveClass(/is-zoomed/);
    await settled();
    // The spot three quarters across the picture stays under the finger.
    const spot = await picture.evaluate((media) => {
      const drawn = media.getBoundingClientRect();
      const holder = media.parentElement!.getBoundingClientRect();
      return {
        zoomedAt: drawn.left + drawn.width * 0.75,
        restingAt: holder.left + holder.width / 2 + media.clientWidth * 0.25,
        scale: drawn.width / media.clientWidth
      };
    });
    expect(spot.scale).toBeCloseTo(2.5, 1);
    expect(Math.abs(spot.zoomedAt - spot.restingAt)).toBeLessThan(2);

    const zoomedBox = (await wrap.boundingBox())!;
    await tapTwice(zoomedBox.x + zoomedBox.width / 2, zoomedBox.y + zoomedBox.height / 2);
    await expect(wrap).not.toHaveClass(/is-zoomed/);
    await expect(frame).toHaveClass(/is-fullscreen/);
  });

  test('fullscreen grows the picture from where it was and shrinks it back, without a jump or a stretch', async ({ page }) => {
    await page.goto('/app/gallery');
    await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').tap();
    const picture = page.locator('.file-detail-panel-current img.file-detail-media');
    await expect(picture).toBeVisible();
    const settled = () => expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    await settled();
    // The drawn picture (object-fit: contain) on every frame, transform included.
    const record = () => page.evaluate(() => {
      const samples: { left: number; top: number; width: number; height: number }[] = [];
      (window as unknown as { samples: typeof samples }).samples = samples;
      const tick = () => {
        const media = document.querySelector<HTMLImageElement>('.file-detail-panel-current img.file-detail-media');
        if (media) {
          const box = media.getBoundingClientRect();
          const scale = Math.min(box.width / media.naturalWidth, box.height / media.naturalHeight);
          const width = media.naturalWidth * scale;
          const height = media.naturalHeight * scale;
          samples.push({ left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height });
        }
        if (samples.length < 120) requestAnimationFrame(tick);
      };
      tick();
    });
    const samples = () => page.evaluate(() => (window as unknown as { samples: { left: number; top: number; width: number; height: number }[] }).samples);
    const check = async (growing: boolean) => {
      await settled();
      const seen = await samples();
      const [from] = seen;
      const to = seen.at(-1)!;
      expect(growing ? to.width > from.width : to.width < from.width).toBe(true);
      // It travels through sizes in between rather than appearing at the end.
      const between = seen.filter((box) => Math.abs(box.width - from.width) > 1 && Math.abs(box.width - to.width) > 1);
      expect(between.length).toBeGreaterThanOrEqual(4);
      for (let index = 1; index < seen.length; index += 1) {
        // Never back past where it was going: the reported "zoomed backwards" open.
        const change = seen[index].width - seen[index - 1].width;
        expect(growing ? change : -change).toBeGreaterThanOrEqual(-0.5);
        // No jump on the way.
        expect(Math.abs(seen[index].top - seen[index - 1].top)).toBeLessThan(80);
        // One scale for both sides.
        expect(Math.abs(seen[index].width / seen[index].height - from.width / from.height)).toBeLessThan(0.02);
      }
    };
    await record();
    await page.locator('.file-detail-panel-current .file-detail-fullscreen-btn').tap();
    await check(true);
    await record();
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
    await check(false);
    // The browser's Back leaves fullscreen the same way.
    await page.locator('.file-detail-panel-current .file-detail-fullscreen-btn').tap();
    await settled();
    await record();
    await page.goBack();
    await check(false);
  });

  test('the thumbnail stands in while the picture loads and is gone once it has', async ({ page }) => {
    // The original arrives late, so the thumbnail under it can be seen standing in.
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/files/*/content*', async (route) => {
      await held;
      await route.continue();
    });
    await page.goto('/app/gallery');
    await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').tap();
    const wrap = page.locator('.file-detail-panel-current .file-detail-media-wrap');
    const poster = () => wrap.evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return style.display === 'none' ? 'none' : style.backgroundImage;
    });
    await expect.poll(poster).toContain('url(');
    release();
    await expect(wrap.locator('img')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    // Once the picture is in, the thumbnail under it has no use, and it would show as a second
    // copy behind the picture while fullscreen grows it.
    await expect.poll(poster).toBe('none');
  });

  test('a pinch zooms only the fullscreen picture, a finger moves around it, and exit stays on screen', async ({ page }) => {
    await page.goto('/app/gallery');
    await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').tap();
    await page.getByRole('button', { name: 'View fullscreen', exact: true }).tap();
    const frame = page.locator('.file-detail-frame.is-fullscreen');
    const wrap = frame.locator('.file-detail-panel-current .file-detail-media-wrap');
    await expect(wrap.locator('img')).toBeVisible();
    // Votes, arrows, back and the actions menu stay out of fullscreen.
    await expect(frame.getByRole('button')).toHaveCount(1);
    const exit = frame.getByRole('button', { name: 'Exit fullscreen', exact: true });
    const fileId = new URL(page.url()).searchParams.get('fileId');
    const box = await wrap.boundingBox();
    if (!box) throw new Error('No media to zoom');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    // A tap on the picture itself is not a tap on the letterboxing.
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(400);
    await expect(frame).toHaveCount(1);
    const zoom = () => wrap.evaluate((element) => (element as HTMLElement).style.getPropertyValue('--file-detail-zoom'));
    let before: string;
    const input = await page.context().newCDPSession(page);
    try {
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 30, y, id: 1 }, { x: x + 30, y, id: 2 }] });
      for (const spread of [60, 90, 120]) {
        await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - spread, y, id: 1 }, { x: x + spread, y, id: 2 }] });
      }
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(wrap).toHaveClass(/is-zoomed/);
      // The app scaled the picture, not the browser the page.
      expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
      await expect(exit).toBeInViewport({ ratio: 1 });
      before = await zoom();
      await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (const step of [30, 60, 90]) {
        await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - step, y }] });
      }
      // Held still before lifting: a lift at speed is a fling, and Chromium
      // swallows the next tap as the one that stops it.
      await page.waitForTimeout(300);
      await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 90, y: y + 1 }] });
      await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await input.detach();
    }
    await expect.poll(zoom).not.toBe(before);
    await page.waitForTimeout(400);
    expect(new URL(page.url()).searchParams.get('fileId')).toBe(fileId);
    await exit.tap();
    await expect(page.locator('.file-detail-frame')).not.toHaveClass(/is-fullscreen/);
  });

  test('Explore fullscreen shows only the exit button', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page);
    await page.getByRole('button', { name: 'View fullscreen', exact: true }).tap();
    const frame = page.locator('.file-detail-frame.is-fullscreen');
    await expect(frame.getByRole('button')).toHaveCount(1);
    await expect(frame.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
  });

  test('with Actions in fullscreen, only the More actions button sits left of the exit button, in its size, and its menu opens on top', async ({ page }) => {
    // Only this page sees the setting on: the database is shared with tests running alongside.
    await page.route('**/settings/extra', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), fullscreenActions: true } });
    });
    await page.goto('/app/gallery');
    await openExplore(page);
    // Not tap(): it scrolls the frame sideways to reach the button, and the exit button with it.
    await page.getByRole('button', { name: 'View fullscreen', exact: true }).dispatchEvent('click');
    await expect(page.locator('.file-detail-frame.is-fullscreen')).toBeVisible();
    const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true });
    const trigger = page.locator('.phone-actions').getByRole('button', { name: 'More actions' });
    await expect(trigger).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    // The quick action of the corner goes into the menu: one button, nothing beside it.
    await expect(page.locator('.phone-actions').getByRole('button')).toHaveCount(1);
    const [exitBox, triggerBox] = [(await exit.boundingBox())!, (await trigger.boundingBox())!];
    expect(triggerBox.x + triggerBox.width).toBeLessThanOrEqual(exitBox.x);
    expect(triggerBox.y + triggerBox.height / 2).toBeCloseTo(exitBox.y + exitBox.height / 2, 0);
    expect(triggerBox.width).toBeCloseTo(exitBox.width, 0);
    // Hit-testing, not only geometry: the fullscreen layer must not cover the buttons.
    const onTop = (box: { x: number; y: number; width: number; height: number }, selector: string) =>
      page.evaluate(([x, y, s]) => !!document.elementFromPoint(x as number, y as number)?.closest(s as string),
        [box.x + box.width / 2, box.y + box.height / 2, selector]);
    expect(await onTop(triggerBox, '.file-detail-more-action')).toBe(true);
    await trigger.tap();
    const menu = page.getByRole('dialog', { name: 'Actions for this post' });
    await expect(menu).toBeVisible();
    await page.waitForFunction(() => document.querySelector('.more-actions-menu')?.getAnimations().length === 0);
    expect(await onTop((await menu.boundingBox())!, '.more-actions-menu')).toBe(true);
  });

  test('the favorite and vote buttons sit at the bottom right of the screen at every width', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page);
    const cluster = page.locator('.phone-actions');
    await expect(cluster).toBeVisible();
    const corner = () => cluster.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { right: window.innerWidth - box.right, bottom: window.innerHeight - box.bottom, inFrame: !!element.closest('.file-detail-frame') };
    });
    const before = await corner();
    expect(before).toEqual({ right: 20, bottom: 20, inFrame: false });
    const toastGap = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;bottom:var(--toast-offset-bottom);height:1px;width:1px';
      document.body.append(probe);
      const gap = window.innerHeight - probe.getBoundingClientRect().bottom;
      probe.remove();
      return gap;
    });
    expect(toastGap).toBeGreaterThan(await cluster.evaluate((element) => element.getBoundingClientRect().height + 16));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    expect(await corner()).toEqual(before);
    await page.setViewportSize({ width: 1200, height: 852 });
    await expect(cluster).toBeVisible();
    expect(await corner()).toEqual({ right: 24, bottom: 24, inFrame: false });
  });

  for (const width of [375, 749]) {
    test(`at ${width}px the actions open in a menu above the More actions button, one row per action`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      await page.goto('/app/gallery');
      await openExplore(page);
      const trigger = page.locator('.phone-actions').getByRole('button', { name: 'More actions' });
      await trigger.click();
      const menu = page.getByRole('dialog', { name: 'Actions for this post' });
      await expect(menu).toBeVisible();
      await page.waitForFunction(() => document.querySelector('.more-actions-menu')?.getAnimations().length === 0);
      const [box, button] = [(await menu.boundingBox())!, (await trigger.boundingBox())!];
      expect(box.y + box.height).toBeLessThanOrEqual(button.y);
      expect(Math.abs(box.x + box.width - (button.x + button.width))).toBeLessThan(1);
      expect(box.x).toBeGreaterThanOrEqual(0);
    });
  }

  test('Explore keeps the favorite in the corner, and sharing and voting in the actions panel', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page);
    const corner = page.locator('.phone-actions');
    await expect(corner.getByRole('button', { name: 'Favorite and save' })).toBeVisible();
    await expect(corner.getByRole('button', { name: 'Vote up' })).toHaveCount(0);
    const scrolled = await page.evaluate(() => window.scrollY);
    await corner.getByRole('button', { name: 'More actions' }).click();
    const panel = page.getByRole('dialog', { name: 'Actions for this post' });
    // The votes are rows of the same plain list as Share: named, as wide as it, one under the other.
    await expect(panel.getByRole('heading', { name: 'Actions', exact: true })).toHaveCount(0);
    const vote = panel.getByRole('group', { name: 'Vote' });
    const rows = [vote.getByRole('button', { name: 'Vote up' }), vote.getByRole('button', { name: 'Vote down' }), panel.locator('.panel-pill')];
    await expect(rows[0]).toHaveText('Vote up');
    await expect(rows[1]).toHaveText('Vote down');
    await expect(rows[2]).toHaveText('Share');
    const boxes = await Promise.all(rows.map(async (row) => (await row.boundingBox())!));
    for (const [above, below] of [[boxes[0], boxes[1]], [boxes[1], boxes[2]]]) {
      expect(above.y + above.height).toBeLessThanOrEqual(below.y + 1);
      expect(Math.abs(above.width - below.width)).toBeLessThan(1);
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.locator('.file-detail-panel-current')).toBeVisible();
  });

  test('the quick button chosen in Appearance replaces the favorite beside the menu', async ({ page }) => {
    await page.goto('/app/settings/appearance');
    const picker = page.getByRole('radiogroup', { name: 'Open post in Explore' });
    await expect(picker.getByRole('radio', { name: 'Favorite' })).toBeChecked();
    await picker.getByText('Share', { exact: true }).click();
    await expect(picker.getByRole('radio', { name: 'Share' })).toBeChecked();

    await page.goto('/app/gallery');
    await openExplore(page);
    const corner = page.locator('.phone-actions');
    await expect(corner.getByRole('button', { name: 'Share' })).toBeVisible();
    await expect(corner.getByRole('button', { name: 'Favorite and save' })).toHaveCount(0);
    await corner.getByRole('button', { name: 'More actions' }).click();
    const panel = page.getByRole('dialog', { name: 'Actions for this post' });
    await expect(panel.getByRole('button', { name: 'Favorite and save' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Share' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.goto('/app/settings/appearance');
    await page.getByRole('radiogroup', { name: 'Open post in Explore' }).getByText('None', { exact: true }).click();
    await page.getByRole('radiogroup', { name: 'Gallery', exact: true }).getByText('None', { exact: true }).click();
    await page.goto('/app/gallery');
    await expect(page.locator('.search-lens-action')).toHaveCount(0);
    await expect(page.locator('.search-lens')).toBeVisible();
  });

  test('Explore fades the overlay and keeps the actions after a swipe', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page);
    const frame = page.locator('.file-detail-frame');
    const button = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.install();
    await page.clock.fastForward(4_250);
    await expect(frame).not.toHaveClass(/is-overlay-active/);
    await swipeNext(page);
    await page.clock.runFor(250);
    await expect(page.locator('.file-detail-panel-current img.file-detail-media')).toHaveAttribute('alt', 'Post 2 on Fixture');
    await expect(page.locator('.phone-actions')).toBeVisible();
  });

  test('a post whose site gives the wrong width and height still shows its thumbnail only under the picture', async ({ page }) => {
    await page.goto('/app/gallery');
    // The fixture says 640×480; the picture it serves is square.
    await openExplore(page);
    const wrap = page.locator('.file-detail-panel-current .file-detail-media-wrap');
    const picture = wrap.locator('img.file-detail-media');
    await expect.poll(() => picture.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    const natural = await picture.evaluate((element: HTMLImageElement) => element.naturalWidth / element.naturalHeight);
    expect(natural).toBeCloseTo(1, 2);
    const poster = () => wrap.evaluate((element) => {
      const style = getComputedStyle(element, '::before');
      return parseFloat(style.width) / parseFloat(style.height);
    });
    await expect.poll(poster).toBeCloseTo(natural, 2);
  });

  test('a video of another shape than its site says shows no copy of its thumbnail beside it, in or out of fullscreen', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page, '240x320');
    const wrap = page.locator('.file-detail-panel-current .file-detail-media-wrap');
    const video = wrap.locator('video.file-detail-media');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    // Whether the thumbnail under the video reaches past the frame the video draws.
    const uncovered = () => wrap.evaluate((element) => {
      const poster = getComputedStyle(element, '::before');
      if (poster.display === 'none' || poster.backgroundImage === 'none') return false;
      const media = element.querySelector('video')!;
      const box = media.getBoundingClientRect();
      const scale = Math.min(box.width / media.videoWidth, box.height / media.videoHeight);
      return parseFloat(poster.width) > media.videoWidth * scale + 1 || parseFloat(poster.height) > media.videoHeight * scale + 1;
    });
    await expect.poll(uncovered).toBe(false);
    await page.getByRole('button', { name: 'View fullscreen', exact: true }).tap();
    await expect(page.locator('.file-detail-frame.is-fullscreen')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    await expect.poll(uncovered).toBe(false);
  });

  test('a swipe that starts on a link in the description moves to the next post', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page, false, '[The artist page with everything else](https://fixture.invalid/artist)');
    const link = page.locator('.file-detail-panel-current').getByRole('link', { name: 'The artist page' });
    await link.scrollIntoViewIfNeeded();
    // While the opening transition runs the page takes no touch at all.
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    const box = await link.boundingBox();
    if (!box) throw new Error('No link to swipe');
    // The whole drag runs along the link, so the finger lands on it.
    expect(box.width).toBeGreaterThan(page.viewportSize()!.width * 0.5);
    await swipeNext(page, link);
    await expect(page.locator('.file-detail-panel-current img.file-detail-media')).toHaveAttribute('alt', 'Post 2 on Fixture');
  });

  for (const view of ['Gallery', 'Explore']) {
    test(`${view} vertical drags do not toggle media controls`, async ({ page }) => {
      await page.goto('/app/gallery');
      if (view === 'Explore') await openExplore(page);
      else await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').tap();
      const frame = page.locator('.file-detail-frame');
      const media = page.locator('.file-detail-panel-current .file-detail-media');
      // Wait for navigation's snapshot to stop intercepting touches before freezing time.
      await expect.poll(() => media.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      })).toBe(true);
      await page.clock.install();
      const input = await page.context().newCDPSession(page);
      const drag = async (direction: number, visible: boolean) => {
        await media.scrollIntoViewIfNeeded();
        const box = await media.boundingBox();
        if (!box) throw new Error('No media to scroll');
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        expect(await frame.evaluate((element) => element.classList.contains('is-overlay-active'))).toBe(visible);
        await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + direction * 60 }] });
        await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        expect(await frame.evaluate((element) => element.classList.contains('is-overlay-active'))).toBe(visible);
      };
      try {
        // Down from the top of the page is the drag into fullscreen.
        await drag(-1, true);
        await drag(-1, true);
        await media.tap();
        await expect(frame).not.toHaveClass(/is-overlay-active/);
        await drag(-1, false);
        await media.tap();
        await expect(frame).toHaveClass(/is-overlay-active/);
      } finally {
        await input.detach();
      }
    });
  }

  test('the buttons over a video are 48px and the video bar still fits beside them', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page, true);
    const size = (selector: string) => page.locator(selector).first().evaluate((element) => {
      const { width, height } = element.getBoundingClientRect();
      return { width, height };
    });
    await expect(page.locator('.phone-actions')).toBeVisible();
    expect(await size('.phone-actions button')).toEqual({ width: 48, height: 48 });
    // Every button or pair of the corner has a shadow; a shadow per pair member would fall on its neighbour.
    const shadows = await page.locator('.phone-actions > *').evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).boxShadow));
    expect(shadows.length).toBeGreaterThan(1);
    expect(shadows.filter((shadow) => shadow === 'none')).toEqual([]);
    // The picture shows through the buttons on it.
    const fill = await page.locator('.file-detail-panel-current .file-detail-fullscreen-btn')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(fill).toMatch(/0\.62\)$/);
    expect(await size('.file-detail-panel-current .file-detail-fullscreen-btn')).toEqual({ width: 44, height: 44 });
    expect((await size('.file-detail-panel-current .video-controls')).height).toBe(44);

    const fits = await page.locator('.file-detail-panel-current').evaluate((panel) => {
      const bar = panel.querySelector('.video-controls-bar')!;
      const track = bar.querySelector('input[type="range"]')!.getBoundingClientRect();
      const fullscreen = panel.querySelector('.file-detail-fullscreen-btn')!.getBoundingClientRect();
      return {
        noOverflow: bar.scrollWidth <= bar.clientWidth,
        trackWidth: track.width,
        clearOfFullscreen: bar.getBoundingClientRect().right <= fullscreen.left
      };
    });
    expect(fits.noOverflow).toBe(true);
    expect(fits.clearOfFullscreen).toBe(true);
    expect(fits.trackWidth).toBeGreaterThan(40);
  });

  test('playing video controls share the touch timer and work in fullscreen', async ({ page }) => {
    // The fake clock below would hold the fullscreen animation; this test is about the timer.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/app/gallery');
    await openExplore(page, true);
    await page.getByRole('button', { name: 'Play', exact: true }).tap();
    const video = page.locator('.file-detail-panel-current video');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    const controls = page.locator('.video-controls');
    const button = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
    await expect(controls).toHaveCSS('opacity', '1');
    await page.clock.install();
    await page.clock.fastForward(4_250);
    await expect(controls).toHaveCSS('opacity', '0');
    await expect(button).toHaveCSS('opacity', '1');
    await video.tap();
    await page.clock.runFor(300);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    await expect(controls).toHaveCSS('opacity', '1');
    await expect(button).toHaveCSS('opacity', '1');
    await button.tap();
    const exit = page.locator('.file-detail-frame > .file-detail-fullscreen-btn');
    await expect(exit).toHaveCSS('opacity', '1');
    await video.tap({ position: { x: 40, y: 100 } });
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    await page.clock.fastForward(4_250);
    await expect(controls).toHaveCSS('opacity', '0');
    await expect(exit).toHaveCSS('opacity', '1');
    // Two quick taps are the double tap that leaves fullscreen.
    await page.waitForTimeout(500);
    await video.tap({ position: { x: 40, y: 100 } });
    await expect(exit).toHaveCSS('opacity', '1');
    await exit.tap();
    await expect(page.locator('.file-detail-frame')).not.toHaveClass(/is-fullscreen/);
  });

  test('the gallery video bar stays beside fullscreen when it fits', async ({ page }) => {
    const settingsResponse = await page.request.get('/settings/extra');
    const settings = await settingsResponse.json();
    await page.route('**/settings/extra', (route) => route.fulfill({ json: { ...settings, voteSystemEnabled: false } }));
    const foldersResponse = await page.request.get('/folders');
    const { folders } = await foldersResponse.json() as { folders: { id: string }[] };
    const upload = await page.request.post(`/folders/${folders[0].id}/uploads`, {
      multipart: { files: { name: 'overlay-inline.mp4', mimeType: 'video/mp4', buffer: videoFixture() } }
    });
    expect(upload.ok()).toBe(true);
    const { uploaded } = await upload.json() as { uploaded: { fileId: string }[] };
    expect(uploaded).toHaveLength(1);
    try {
      await page.goto(`/app/gallery?fileId=${uploaded[0].fileId}`);
      const controls = page.locator('.video-controls');
      await expect(controls).toBeVisible();
      for (const width of [375, 480, 640]) {
        await page.setViewportSize({ width, height: 812 });
        const row = await controls.evaluate((element) => {
          const bar = element.getBoundingClientRect();
          const button = document.querySelector('.file-detail-panel-current .file-detail-fullscreen-btn')!.getBoundingClientRect();
          const seek = document.querySelector('.video-controls-seek')!.getBoundingClientRect();
          return { gap: button.left - bar.right, verticalOffset: Math.abs(button.top - bar.top), seek: seek.width };
        });
        expect(row.verticalOffset).toBeLessThan(1);
        expect(row.gap).toBeGreaterThanOrEqual(8);
        expect(row.seek).toBeGreaterThan(0);
      }
    } finally {
      const removed = await page.request.delete(`/files/${uploaded[0].fileId}`);
      expect(removed.ok()).toBe(true);
    }
  });

  test('a double click on the left of a gallery video skips back, two real taps on the right skip forward', async ({ page }) => {
    const foldersResponse = await page.request.get('/folders');
    const { folders } = await foldersResponse.json() as { folders: { id: string }[] };
    const upload = await page.request.post(`/folders/${folders[0].id}/uploads`, {
      multipart: { files: { name: 'overlay-skip.mp4', mimeType: 'video/mp4', buffer: videoFixture() } }
    });
    expect(upload.ok()).toBe(true);
    const { uploaded } = await upload.json() as { uploaded: { fileId: string }[] };
    try {
      await page.goto(`/app/gallery?fileId=${uploaded[0].fileId}`);
      const video = page.locator('.file-detail-panel-current video');
      await expect(video).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
      const box = await video.boundingBox();
      if (!box) throw new Error('No video to tap');
      const y = box.y + box.height / 2;
      await page.mouse.dblclick(box.x + box.width * 0.15, y);
      await expect(page.locator('.video-skip-hint')).toHaveText('−10 s');
      await expect(page.locator('.file-detail-frame')).not.toHaveClass(/is-fullscreen/);

      // iOS does not reliably turn two quick taps into a dblclick.
      await page.evaluate(() => window.addEventListener('dblclick', (event) => event.stopPropagation(), true));
      const frame = page.locator('.file-detail-frame');
      await page.clock.install();
      await page.clock.fastForward(4_250);
      await expect(frame).not.toHaveClass(/is-overlay-active/);
      const x = box.x + box.width * 0.85;
      // Records whether the controls came up at any moment, not only at the end.
      await frame.evaluate((element) => {
        const seen = { shown: false };
        (window as unknown as { overlaySeen: typeof seen }).overlaySeen = seen;
        new MutationObserver(() => {
          if (element.classList.contains('is-overlay-active')) seen.shown = true;
        }).observe(element, { attributes: true, attributeFilter: ['class'] });
      });
      await page.touchscreen.tap(x, y);
      await page.touchscreen.tap(x, y);
      await expect(page.locator('.video-skip-hint')).toHaveText('+10 s');
      await expect(frame).not.toHaveClass(/is-fullscreen/);
      // The two taps skip; they do not also show the controls and the actions.
      await page.clock.runFor(400);
      expect(await page.evaluate(() => (window as unknown as { overlaySeen: { shown: boolean } }).overlaySeen.shown)).toBe(false);

    } finally {
      const removed = await page.request.delete(`/files/${uploaded[0].fileId}`);
      expect(removed.ok()).toBe(true);
    }
  });

  test('a fullscreen gallery video shows only the exit button beside its playback bar', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 393, height: 852 });
    const settings = await (await page.request.get('/settings/extra')).json();
    await page.route('**/settings/extra', (route) => route.fulfill({ json: { ...settings, voteSystemEnabled: true } }));
    const { folders } = await (await page.request.get('/folders')).json() as { folders: { id: string }[] };
    const upload = await page.request.post(`/folders/${folders[0].id}/uploads`, {
      multipart: { files: { name: 'fullscreen-layout.mp4', mimeType: 'video/mp4', buffer: videoFixture() } }
    });
    expect(upload.ok()).toBe(true);
    const { uploaded } = await upload.json() as { uploaded: { fileId: string }[] };
    expect(uploaded).toHaveLength(1);
    try {
      // A score shows the vote button, which fullscreen used to carry.
      await page.route(/\/files\?/, async (route) => {
        const response = await route.fetch();
        const body = await response.json() as { files: { voteScore: number }[] };
        for (const file of body.files) file.voteScore = 1;
        await route.fulfill({ response, json: body });
      });
      await page.goto(`/app/gallery?fileId=${uploaded[0].fileId}`);
      await expect.poll(() => page.locator('video').evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'View fullscreen', exact: true }).tap();
      const frame = page.locator('.file-detail-frame');
      await expect(frame.getByRole('button', { name: /^(Vote|Delete|Previous|Next|Back)/ })).toHaveCount(0);
      for (const viewport of [{ width: 320, height: 812 }, { width: 393, height: 852 }, { width: 852, height: 393 }]) {
        await page.setViewportSize(viewport);
        const layout = await frame.evaluate((element) => {
          const bar = element.querySelector('.video-controls')!.getBoundingClientRect();
          const exit = element.querySelector(':scope > .file-detail-fullscreen-btn')!.getBoundingClientRect();
          const seek = element.querySelector('.video-controls-seek')!.getBoundingClientRect();
          return { verticalOffset: Math.abs(bar.top - exit.top), gap: exit.left - bar.right, seekWidth: seek.width };
        });
        expect(layout.verticalOffset).toBeLessThan(1);
        expect(layout.gap).toBeGreaterThanOrEqual(8);
        expect(layout.seekWidth).toBeGreaterThan(0);
        if (viewport.width === 393) await page.screenshot({ path: testInfo.outputPath('fullscreen-controls.png') });
      }
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
      await page.setViewportSize({ width: 393, height: 852 });
      await expect(page.locator('.phone-actions')).toBeVisible();
      await page.setViewportSize({ width: 1200, height: 852 });
      await expect(page.locator('.phone-actions')).toBeVisible();
    } finally {
      expect((await page.request.delete(`/files/${uploaded[0].fileId}`)).ok()).toBe(true);
    }
  });

  test('Explore wraps votes and favorite only when the controls need another row', async ({ page }, testInfo) => {
    await page.goto('/app/gallery');
    await openExplore(page, true);
    const seek = page.getByRole('slider', { name: 'Seek', exact: true });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    for (const width of [320, 375, 480, 640, 1200]) {
      await page.setViewportSize({ width, height: 812 });
      await expect(page.locator('.phone-actions')).toHaveCount(1);
      await expect.poll(() => seek.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(0);
      const layout = await seek.evaluate((element) => {
        const bar = element.closest('.video-controls')!.getBoundingClientRect();
        const actions = document.querySelector('.phone-actions')!.getBoundingClientRect();
        const fullscreen = document.querySelector('.file-detail-panel-current .file-detail-fullscreen-btn')!.getBoundingClientRect();
        return { actionsGap: bar.top - actions.bottom, verticalOffset: Math.abs(bar.top - fullscreen.top) };
      });
      {
        const touching = await seek.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return Array.from(document.querySelectorAll('.phone-actions button')).some((button) => {
            const other = button.getBoundingClientRect();
            return box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top;
          });
        });
        expect(touching).toBe(false);
      }
      expect(layout.verticalOffset).toBeLessThan(1);
      const time = await page.locator('.video-controls-time').evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const rects = Array.from(range.getClientRects());
        const seek = document.querySelector('.video-controls-seek')!.getBoundingClientRect();
        return { lines: new Set(rects.map((rect) => rect.top)).size, right: element.getBoundingClientRect().right, seekLeft: seek.left };
      });
      expect(time.lines).toBe(1);
      expect(time.right).toBeLessThanOrEqual(time.seekLeft);
      if (width === 375 || width === 1200) await page.screenshot({ path: testInfo.outputPath(`explore-video-controls-${width}.png`) });
    }
    const overlaps = await seek.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return Array.from(document.querySelectorAll('.phone-actions button, .file-detail-panel-current .file-detail-fullscreen-btn')).some((button) => {
        const other = button.getBoundingClientRect();
        return box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top;
      });
    });
    expect(overlaps).toBe(false);
  });

  test('Explore: the post that slides in carries the same buttons as the open post', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page);
    const count = (panel: string, selector: string) => page.locator(`.file-detail-panel-${panel} ${selector}`).count();
    for (const selector of ['.file-detail-overlay-back', '.file-detail-fullscreen-btn']) {
      const open = await count('current', selector);
      expect(open, selector).toBeGreaterThan(0);
      expect(await count('next', selector), selector).toBe(open);
    }
    await expect(page.locator('.file-detail-panel-next .file-detail-tags')).toContainText('fixture_artist');
  });
});

test('the fullscreen button is shown without hover, focus or a touch', async ({ page }) => {
  await page.goto('/app/gallery');
  await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').click();
  await page.mouse.move(0, 0);
  const button = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
  await page.clock.install();
  await page.clock.fastForward(4_250);
  await expect(button).toHaveCSS('opacity', '1');
  await expect(button).toHaveCSS('pointer-events', 'auto');
});

test.describe('iPhone shared video controls', () => {
  test.use({
    hasTouch: true, isMobile: true, viewport: PHONE.viewport,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
  });

  test('playing video and app actions toggle and auto-hide together after four seconds', async ({ page }) => {
    // The fake clock below would hold the fullscreen animation; this test is about the timer.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // Only this page sees the setting off: the database is shared with tests running alongside.
    await page.route('**/settings/extra', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), fullscreenActions: false } });
    });
    await page.goto('/app/gallery');
    await openExplore(page, true);
    const video = page.locator('.file-detail-panel-current video');
    await expect(video).not.toHaveAttribute('controls');
    await expect(page.locator('.file-detail-panel-current .file-detail-overlay-back')).toHaveCSS('top', '12px');
    await expect(video).toHaveAttribute('playsinline', '');
    // Play and pause sit in the middle; the rest of the picture takes the taps.
    await expect.poll(() => video.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + 40, box.y + 100));
    })).toBe(true);
    await page.clock.install();
    const controls = page.locator('.video-controls');
    // Out of fullscreen the phone buttons stay shown; with Actions in fullscreen off, fullscreen has none.
    const row = page.locator('.phone-actions');
    const fullscreen = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn, .file-detail-frame > .file-detail-fullscreen-btn');
    const synced = async (opacity: string) => {
      await expect(controls).toHaveCSS('opacity', opacity);
      if (await row.count()) await expect(row).toHaveCSS('opacity', '1');
      await expect(fullscreen).toHaveCSS('opacity', '1');
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    };
    // Pressing Play hides the controls at once: the video is what the person wants to see.
    await page.getByRole('button', { name: 'Play', exact: true }).tap();
    await expect(page.locator('.file-detail-frame')).not.toHaveClass(/is-overlay-active/);
    await synced('0');
    for (const opacity of ['1', '0', '1']) {
      // Separate taps from the intentional double-tap fullscreen gesture.
      await page.waitForTimeout(500);
      await video.tap({ position: { x: 40, y: 100 } });
      await page.clock.runFor(300);
      await synced(opacity);
    }
    await page.getByRole('button', { name: 'Mute', exact: true }).tap();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(true);
    await synced('1');
    await page.getByRole('slider', { name: 'Seek', exact: true }).fill('2');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(2);
    await fullscreen.tap();
    await synced('1');
    await page.clock.fastForward(3_500);
    await synced('1');
    await page.clock.fastForward(750);
    await synced('0');
    await video.tap();
    await page.clock.runFor(300);
    await synced('1');
    await page.getByRole('button', { name: 'Pause', exact: true }).tap();
    await page.clock.fastForward(4_250);
    await expect(controls).toHaveCSS('opacity', '1');
    await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'Play', exact: true }).tap();
    await expect(page.locator('.file-detail-frame')).not.toHaveClass(/is-overlay-active/);
    await synced('0');
  });
});
