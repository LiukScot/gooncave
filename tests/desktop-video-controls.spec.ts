import { expect, test } from '@playwright/test';

import { videoFixture } from './helpers';

test.describe('desktop video controls', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a still mouse lets the playing controls hide, and a click on the picture shows or hides them without pausing', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { folders } = await (await page.request.get('/folders')).json() as { folders: { id: string }[] };
    const upload = await page.request.post(`/folders/${folders[0].id}/uploads`, {
      multipart: { files: { name: 'desktop-controls.mp4', mimeType: 'video/mp4', buffer: videoFixture() } }
    });
    expect(upload.ok()).toBe(true);
    const { uploaded } = await upload.json() as { uploaded: { fileId: string }[] };
    try {
      await page.goto(`/app/gallery?fileId=${uploaded[0].fileId}`);
      const video = page.locator('.file-detail-panel-current video');
      await expect(video).toBeVisible();
      await video.evaluate((element: HTMLVideoElement) => { element.loop = true; });
      const play = page.getByRole('button', { name: 'Play', exact: true });
      const box = await video.boundingBox();
      const button = await play.boundingBox();
      if (!box || !button) throw new Error('No video or play button');
      // Play sits in the middle of the picture.
      expect(Math.abs(button.x + button.width / 2 - (box.x + box.width / 2))).toBeLessThan(2);
      expect(Math.abs(button.y + button.height / 2 - (box.y + box.height / 2))).toBeLessThan(2);
      await play.click();
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);

      const controls = page.locator('.video-controls');
      const fullscreen = page.locator('.file-detail-panel-current .file-detail-fullscreen-btn');
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
      await page.clock.install();
      await expect(controls).toHaveCSS('opacity', '1');
      await page.clock.fastForward(4_250);
      await expect(controls).toHaveCSS('opacity', '0');
      await expect(fullscreen).toHaveCSS('opacity', '1');

      for (const opacity of ['1', '0']) {
        await page.mouse.down();
        await page.mouse.up();
        await page.clock.runFor(300);
        await expect(controls).toHaveCSS('opacity', opacity);
        await expect(fullscreen).toHaveCSS('opacity', '1');
        expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
      }
    } finally {
      const removed = await page.request.delete(`/files/${uploaded[0].fileId}`);
      expect(removed.ok()).toBe(true);
    }
  });
});
