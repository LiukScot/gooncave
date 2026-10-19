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

  test('opening a gallery image shows controls for three seconds and hidden controls do not intercept taps', async ({ page }) => {
    await page.goto('/app/gallery');
    await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').tap();
    const button = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.install();
    await page.clock.fastForward(2_500);
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

  test('Explore shows controls on open, after a swipe and after a touch', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page);
    const frame = page.locator('.file-detail-frame');
    const button = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.install();
    await page.clock.fastForward(3_250);
    await expect(button).toHaveCSS('opacity', '0');
    await swipeNext(page);
    await page.clock.runFor(250);
    await expect(page.locator('.file-detail-panel-current img.file-detail-media')).toHaveAttribute('alt', 'Post 2 on Fixture');
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.fastForward(2_500);
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.fastForward(750);
    await expect(button).toHaveCSS('opacity', '0');
    await page.locator('.file-detail-panel-current .file-detail-media').tap();
    await expect(button).toHaveCSS('opacity', '1');
    await expect(frame.locator('.file-detail-overlay-row')).toHaveCSS('opacity', '1');
  });

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
    await page.clock.fastForward(3_250);
    await expect(controls).toHaveCSS('opacity', '0');
    await expect(button).toHaveCSS('opacity', '0');
    await video.tap();
    await expect(controls).toHaveCSS('opacity', '1');
    await expect(button).toHaveCSS('opacity', '1');
    await button.tap();
    const exit = page.locator('.file-detail-frame > .file-detail-fullscreen-btn');
    await expect(exit).toHaveCSS('opacity', '1');
    await video.tap();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
    await page.clock.fastForward(3_250);
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
        expect(row.seek).toBeGreaterThanOrEqual(44);
      }
    } finally {
      const removed = await page.request.delete(`/files/${uploaded[0].fileId}`);
      expect(removed.ok()).toBe(true);
    }
  });

  test('the video seek bar has usable width beside all Explore actions', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page, true);
    const seek = page.getByRole('slider', { name: 'Seek', exact: true });
    for (const width of [320, 375, 640]) {
      await page.setViewportSize({ width, height: 812 });
      await expect.poll(() => seek.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
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
});

test('keyboard focus reveals hidden fullscreen controls without mouse hover', async ({ page }) => {
  await page.goto('/app/gallery');
  await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').click();
  await page.mouse.move(0, 0);
  const button = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
  await page.clock.install();
  await page.clock.fastForward(3_250);
  await expect(button).toHaveCSS('opacity', '0');
  await page.keyboard.press('Tab');
  await button.focus();
  await expect(button).toHaveCSS('opacity', '1');
  await expect(button).toHaveCSS('pointer-events', 'auto');
});

test.describe('iOS native-player branch', () => {
  test.use({
    hasTouch: true, isMobile: true, viewport: PHONE.viewport,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
  });

  test('app controls use the timer without replacing native playback controls', async ({ page }) => {
    await page.goto('/app/gallery');
    await openExplore(page, true);
    const video = page.locator('.file-detail-panel-current video');
    await expect(video).toHaveAttribute('controls', '');
    await expect(page.locator('.video-controls')).toHaveCount(0);
    const button = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.install();
    await page.clock.fastForward(3_250);
    await expect(button).toHaveCSS('opacity', '0');
    await video.tap();
    await expect(button).toHaveCSS('opacity', '1');
    await page.clock.fastForward(3_250);
    await expect(button).toHaveCSS('opacity', '0');
  });
});
