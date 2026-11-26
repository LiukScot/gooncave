import { expect, test, videoFixture } from './helpers';

test.use({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } });

test('in fullscreen, a double tap beside or on the side of a narrow video skips instead of zooming', async ({ page }) => {
  // Only this page sees the setting: the database is shared with tests running alongside.
  await page.route('**/settings/extra', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), doubleTap: 'zoom' } });
  });
  const { folders } = await (await page.request.get('/folders')).json() as { folders: { id: string }[] };
  const upload = await page.request.post(`/folders/${folders[0].id}/uploads`, {
    // Narrow enough to leave a band on each side, as a portrait video on a phone does.
    multipart: { files: { name: 'narrow-double-tap.mp4', mimeType: 'video/mp4', buffer: videoFixture('100x400') } }
  });
  expect(upload.ok()).toBe(true);
  const { uploaded } = await upload.json() as { uploaded: { fileId: string }[] };
  try {
    await page.goto(`/app/gallery?fileId=${uploaded[0].fileId}`);
    const frame = page.locator('.file-detail-frame');
    const wrap = page.locator('.file-detail-panel-current .file-detail-media-wrap');
    const video = page.locator('.file-detail-panel-current video');
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(5);
    const settled = () => expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
    await settled();
    await page.locator('.file-detail-panel-current .file-detail-fullscreen-btn').tap();
    await expect(frame).toHaveClass(/is-fullscreen/);
    await settled();
    // Real taps, with Chromium's dblclick dropped: iOS does not reliably send one.
    await page.evaluate(() => window.addEventListener('dblclick', (event) => event.stopPropagation(), true));
    const tapTwice = async (x: number, y: number) => {
      await page.touchscreen.tap(x, y);
      await page.touchscreen.tap(x, y);
    };
    const area = (await wrap.boundingBox())!;
    const shown = (await video.boundingBox())!;
    expect(shown.x - area.x).toBeGreaterThan(30);
    const time = () => video.evaluate((element: HTMLVideoElement) => element.currentTime);

    // The band right of the video.
    await tapTwice(area.x + area.width - 10, area.y + area.height / 2);
    await expect.poll(time).toBeGreaterThan(5);
    await expect(wrap).not.toHaveClass(/is-zoomed/);
    await expect(frame).toHaveClass(/is-fullscreen/);

    // The band left of it, then the video's own left edge.
    await page.waitForTimeout(400);
    await tapTwice(area.x + 10, area.y + area.height / 2);
    await expect.poll(time).toBeLessThan(1);
    await video.evaluate((element: HTMLVideoElement) => { element.currentTime = 3; });
    await page.waitForTimeout(400);
    await tapTwice(shown.x + 5, shown.y + shown.height / 2);
    await expect.poll(time).toBeLessThan(1);
    await expect(wrap).not.toHaveClass(/is-zoomed/);
  } finally {
    const removed = await page.request.delete(`/files/${uploaded[0].fileId}`);
    expect(removed.ok()).toBe(true);
  }
});
