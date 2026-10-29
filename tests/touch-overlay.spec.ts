import { execFileSync } from 'node:child_process';

import { expect, test, type Page } from '@playwright/test';

import type { ExplorePost } from '../frontend/src/api';

const PHONE = {
  hasTouch: true,
  isMobile: true,
  viewport: { width: 375, height: 812 },
  launchOptions: {
    args: ['--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2']
  }
};

const videoFixture = () => execFileSync('ffmpeg', [
  '-v', 'error', '-f', 'lavfi', '-i', 'color=c=slategray:s=320x240:r=10',
  '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mp4',
  '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'
]);

async function openExplore(page: Page, video = false) {
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
    const clip = videoFixture();
    await page.route('**/overlay-fixture.mp4', (route) => route.fulfill({ contentType: 'video/mp4', body: clip }));
  }
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [{
    id: 'fixture', name: 'Fixture', engine: 'e621', baseUrl: 'https://fixture.invalid',
    enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
    engineCredentialSchema: 'username_api_key', sortOrder: 0
  }] } }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: { posts, siteErrors: [], sites: ['fixture'] } }));
  await page.route(/\/explore\/post(?:-tags|-text|-relations|-pools)?\?/, (route) => route.fulfill({ json: {
    post: posts[0], tags: posts[0].tags, title: null, description: null, parent: null, children: [], pools: []
  } }));
  await page.goto('/app/explore');
  await page.getByRole('button', { name: 'Open post 1 from Fixture', exact: false }).click({ position: { x: 8, y: 8 } });
  await expect(page.locator('.file-detail-panel-current')).toBeVisible();
}

async function swipeNext(page: Page) {
  const media = await page.locator('.file-detail-panel-current .file-detail-media').boundingBox();
  if (!media) throw new Error('No media to swipe');
  const y = media.y + media.height / 2;
  const right = media.x + media.width * 0.85;
  const left = media.x + media.width * 0.15;
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

  test('opening a gallery image shows controls for four seconds and hidden controls do not intercept taps', async ({ page }) => {
    await page.goto('/app/gallery');
    await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').tap();
    const button = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.install();
    await page.clock.fastForward(3_500);
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.fastForward(750);
    await expect(button).toHaveCSS('opacity', '0');
    await expect(button).toHaveCSS('pointer-events', 'none');
    const hit = await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    });
    expect(hit).toBe(false);
    await page.locator('.file-detail-panel-current .file-detail-media').tap();
    await expect(button).toHaveCSS('opacity', '1');
  });

  test('the favorite and vote buttons sit at the bottom right of the screen on a phone only', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page);
    const cluster = page.locator('.phone-actions');
    await expect(cluster).toBeVisible();
    const corner = () => cluster.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { right: window.innerWidth - box.right, bottom: window.innerHeight - box.bottom, inFrame: !!element.closest('.file-detail-frame') };
    });
    const before = await corner();
    expect(before).toEqual({ right: 16, bottom: 16, inFrame: false });
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
    await expect(cluster).toHaveCount(0);
    await expect(page.locator('.file-detail-overlay-row')).toHaveCount(1);
  });

  test('Explore shows controls on open, after a swipe and after a touch', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page);
    const frame = page.locator('.file-detail-frame');
    const button = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.install();
    await page.clock.fastForward(4_250);
    await expect(button).toHaveCSS('opacity', '0');
    await swipeNext(page);
    await page.clock.runFor(250);
    await expect(page.locator('.file-detail-panel-current img.file-detail-media')).toHaveAttribute('alt', 'Post 2 on Fixture');
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.fastForward(3_500);
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.fastForward(750);
    await expect(button).toHaveCSS('opacity', '0');
    await page.locator('.file-detail-panel-current .file-detail-media').tap();
    await expect(button).toHaveCSS('opacity', '1');
    await expect(frame.locator('.file-detail-overlay-row')).toHaveCount(0);
    await expect(page.locator('.phone-actions')).toBeVisible();
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
        await drag(-1, true);
        await drag(1, true);
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

  test('playing video controls share the touch timer and work in fullscreen', async ({ page }) => {
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
    await expect(button).toHaveCSS('opacity', '0');
    await video.tap();
    await page.clock.runFor(300);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    await expect(controls).toHaveCSS('opacity', '1');
    await expect(button).toHaveCSS('opacity', '1');
    await button.tap();
    const exit = page.locator('.file-detail-frame > .file-detail-fullscreen-btn');
    await expect(exit).toHaveCSS('opacity', '1');
    await video.tap();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    await page.clock.fastForward(4_250);
    await expect(controls).toHaveCSS('opacity', '0');
    await expect(exit).toHaveCSS('opacity', '0');
    await video.tap();
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

  test('Gallery wraps video actions only when the controls need another row', async ({ page }, testInfo) => {
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
      await page.goto(`/app/gallery?fileId=${uploaded[0].fileId}`);
      await expect.poll(() => page.locator('video').evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Vote up', exact: true }).tap();
      await expect(page.locator('.file-detail-overlay-cooldown')).toBeVisible();
      await page.getByRole('button', { name: 'View fullscreen', exact: true }).tap();
      const frame = page.locator('.file-detail-frame');
      await expect(frame.getByRole('button', { name: 'Delete file', exact: false })).toHaveCount(0);
      for (const viewport of [{ width: 320, height: 812 }, { width: 393, height: 852 }, { width: 852, height: 393 }]) {
        await page.setViewportSize(viewport);
        const layout = await frame.evaluate((element) => {
          const frame = element.getBoundingClientRect();
          const bar = element.querySelector('.video-controls')!.getBoundingClientRect();
          const exit = element.querySelector(':scope > .file-detail-fullscreen-btn')!.getBoundingClientRect();
          const actions = element.querySelector('.file-detail-overlay-actions')!.getBoundingClientRect();
          const seek = element.querySelector('.video-controls-seek')!.getBoundingClientRect();
          const undo = element.querySelector('.file-detail-vote-undo')?.getBoundingClientRect();
          return { undoOverlapsPlayback: undo ? undo.bottom > bar.top && undo.top < bar.bottom : false, verticalOffset: Math.abs(bar.top - exit.top), gap: exit.left - bar.right,
            actionsGap: bar.top - actions.bottom, actionsRight: frame.right - actions.right, seekWidth: seek.width };
        });
        expect(layout.undoOverlapsPlayback).toBe(false);
        expect(layout.verticalOffset).toBeLessThan(1);
        expect(layout.gap).toBeGreaterThanOrEqual(8);
        expect(layout.actionsGap).toBe(viewport.width < 432 ? 8 : -40);
        expect(layout.actionsRight).toBe(viewport.width < 432 ? 12 : 60);
        expect(layout.seekWidth).toBeGreaterThan(0);
        if (viewport.width === 393) await page.screenshot({ path: testInfo.outputPath('fullscreen-controls.png') });
      }
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
      await page.setViewportSize({ width: 393, height: 852 });
      await expect(page.locator('.file-detail-overlay-row')).toHaveCount(0);
      await expect(page.locator('.phone-actions')).toBeVisible();
      for (const width of [768, 1200]) {
        await page.setViewportSize({ width, height: 852 });
        const offset = await page.locator('.file-detail-panel-current .file-detail-overlay-row').evaluate((element) => {
          const actions = element.getBoundingClientRect();
          const bar = document.querySelector('.video-controls')!.getBoundingClientRect();
          return bar.top - actions.bottom;
        });
        expect(offset).toBe(-40);
      }
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
      await expect(page.locator(width < 768 ? '.phone-actions' : '.file-detail-panel-current .file-detail-overlay-row')).toHaveCount(1);
      await expect.poll(() => seek.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(0);
      const layout = await seek.evaluate((element) => {
        const bar = element.closest('.video-controls')!.getBoundingClientRect();
        const actions = (document.querySelector('.file-detail-panel-current .file-detail-overlay-row') ?? document.querySelector('.phone-actions'))!.getBoundingClientRect();
        const fullscreen = document.querySelector('.file-detail-panel-current .file-detail-fullscreen-btn')!.getBoundingClientRect();
        return { actionsGap: bar.top - actions.bottom, verticalOffset: Math.abs(bar.top - fullscreen.top) };
      });
      if (width >= 768) expect(layout.actionsGap).toBe(-40);
      if (width < 768) {
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
      return Array.from(document.querySelectorAll('.file-detail-overlay-row button, .file-detail-panel-current .file-detail-fullscreen-btn')).some((button) => {
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
    for (const selector of ['.file-detail-icon-button', '.file-detail-overlay-back', '.file-detail-fullscreen-btn', '.file-detail-section-toggle-icon']) {
      const open = await count('current', selector);
      expect(open, selector).toBeGreaterThan(0);
      expect(await count('next', selector), selector).toBe(open);
    }
    await expect(page.locator('.file-detail-panel-next .file-detail-tags')).toContainText('fixture_artist');
  });
});

test('keyboard focus reveals hidden fullscreen controls without mouse hover', async ({ page }) => {
  await page.goto('/app/gallery');
  await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').click();
  await page.mouse.move(0, 0);
  const button = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
  await page.clock.install();
  await page.clock.fastForward(4_250);
  await expect(button).toHaveCSS('opacity', '0');
  await page.keyboard.press('Tab');
  await button.focus();
  await expect(button).toHaveCSS('opacity', '1');
  await expect(button).toHaveCSS('pointer-events', 'auto');
});

test.describe('iPhone shared video controls', () => {
  test.use({
    hasTouch: true, isMobile: true, viewport: PHONE.viewport,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
  });

  test('playing video and app actions toggle and auto-hide together after four seconds', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page, true);
    const video = page.locator('.file-detail-panel-current video');
    await expect(video).not.toHaveAttribute('controls');
    await expect(page.locator('.file-detail-panel-current .file-detail-overlay-back')).toHaveCSS('top', '12px');
    await expect(video).toHaveAttribute('playsinline', '');
    await expect.poll(() => video.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    await page.clock.install();
    const controls = page.locator('.video-controls');
    // Out of fullscreen the phone buttons stay shown; in fullscreen they fade with the controls.
    const row = page.locator('.phone-actions, .file-detail-frame > .file-detail-overlay-actions');
    const fullscreen = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn, .file-detail-frame > .file-detail-fullscreen-btn');
    const synced = async (opacity: string) => {
      await expect(controls).toHaveCSS('opacity', opacity);
      await expect(row).toHaveCSS('opacity', (await page.locator('.phone-actions').count()) ? '1' : opacity);
      await expect(fullscreen).toHaveCSS('opacity', opacity);
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    };
    await page.getByRole('button', { name: 'Play', exact: true }).tap();
    await page.clock.fastForward(3_500);
    await synced('1');
    await page.clock.fastForward(750);
    await synced('0');
    for (const opacity of ['1', '0', '1']) {
      // Separate taps from the intentional double-tap fullscreen gesture.
      await page.waitForTimeout(500);
      await video.tap();
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
    await expect(row).toHaveCSS('opacity', '1');
    await page.getByRole('button', { name: 'Play', exact: true }).tap();
    await page.clock.fastForward(3_500);
    await synced('1');
    await page.clock.fastForward(750);
    await synced('0');
  });
});
