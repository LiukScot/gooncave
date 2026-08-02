import { expect, test } from '@playwright/test';

import { loginUi, thumbnailablePng, uploadSampleImages } from './helpers';

// Drive a horizontal swipe on the detail frame. Playwright's touchscreen
// helper only taps, and the gesture needs a move sequence to register.
const swipeLeft = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const el = document.querySelector('.file-detail-frame')!;
    const touch = (x: number) =>
      new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 });
    const send = (type: string, x: number) =>
      el.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === 'touchend' ? [] : [touch(x)],
          changedTouches: [touch(x)]
        })
      );
    send('touchstart', 330);
    for (let i = 1; i <= 12; i++) send('touchmove', 330 - i * 22);
    send('touchend', 66);
  });

// A phone-sized touch viewport: the detail view's back and fullscreen
// handling only breaks once hover is absent and the page scrolls.
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true
});

const UPLOAD_COUNT = 4;

// One test rather than four: /auth/login allows 10 requests per minute and
// the rest of the suite already sits close to that ceiling. The scenarios are
// independent — each one re-enters from the gallery — so they are steps.
let uploadedNames: string[] = [];

test.afterEach(async ({ page }) => {
  if (uploadedNames.length === 0) return;
  const res = await page.request.get('/files?limit=500');
  expect(res.ok(), 'failed to list files during teardown').toBeTruthy();
  const { files } = (await res.json()) as {
    files: { id: string; path: string }[];
  };
  const mine = new Set(uploadedNames);
  const deletions = await Promise.all(
    files
      .filter((file) => mine.has(file.path.split('/').pop() ?? ''))
      .map((file) => page.request.delete(`/files/${file.id}`))
  );
  for (const del of deletions) {
    expect(del.ok(), 'failed to delete uploaded test file').toBeTruthy();
  }
  uploadedNames = [];
});

test('detail view is navigable on a touch device', async ({ page }) => {
  await loginUi(page);
  uploadedNames = Array.from(
    { length: UPLOAD_COUNT },
    (_, i) => `mobile-${Date.now()}-${i}.png`
  );
  // Needs real thumbnails: the preview panels and the swipe poster both
  // depend on thumbUrl being populated.
  await uploadSampleImages(page, uploadedNames, {
    base64: thumbnailablePng
  });

  const tiles = page.locator('[data-test-id="file-card"]');
  const fullscreenButton = page.locator(
    '.file-detail-panel-current .file-detail-fullscreen-btn'
  );
  const overlay = page.locator('.file-detail-media-wrap.is-fullscreen');
  // The smoke DB is seeded and shared across specs, so assert on "enough
  // tiles to have a neighbour on both sides" rather than an exact count.
  const gotoGallery = async () => {
    await page.goto('/app/gallery');
    await expect.poll(() => tiles.count()).toBeGreaterThanOrEqual(3);
  };
  const openDetail = async () => {
    await gotoGallery();
    await tiles.nth(1).click();
    await expect(page).toHaveURL(/\/app\/gallery\?fileId=/);
    await expect(page.getByText('File name:').first()).toBeVisible();
  };

  // Regression: back popped fileId out of the URL, then a second sync effect
  // — still holding the pre-close selection — wrote it straight back and
  // reopened the file. The detail view was inescapable, and a second back
  // skipped past the gallery entirely.
  await test.step('browser back returns to the gallery', async () => {
    await openDetail();
    await page.evaluate(() => window.history.back());

    await expect(page).toHaveURL(/\/app\/gallery$/);
    await expect(page.getByText('File name:')).toHaveCount(0);
    await expect(tiles.first()).toBeVisible();
  });

  // Regression: `.file-detail-track` carries `will-change: transform`, which
  // makes it the containing block for fixed-position descendants. The overlay
  // anchored to the track instead of the viewport, so it hung off the bottom
  // of the screen with its exit button out of reach while scroll was locked.
  await test.step('fullscreen overlay covers the viewport', async () => {
    await openDetail();
    await fullscreenButton.click();
    await expect(overlay).toBeVisible();

    const geometry = await page.evaluate(() => {
      const rect = document
        .querySelector('.file-detail-frame.is-fullscreen')!
        .getBoundingClientRect();
      return {
        top: rect.top,
        left: rect.left,
        bottom: rect.bottom,
        right: rect.right,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth
      };
    });

    expect(geometry.top).toBe(0);
    expect(geometry.left).toBe(0);
    expect(geometry.bottom).toBeGreaterThanOrEqual(geometry.viewportHeight);
    expect(geometry.right).toBeGreaterThanOrEqual(geometry.viewportWidth);

    // The exit control must be inside the viewport, not clipped off-screen.
    const exitBox = await page
      .locator('.file-detail-frame > .file-detail-fullscreen-btn')
      .boundingBox();
    expect(exitBox).not.toBeNull();
    expect(exitBox!.y + exitBox!.height).toBeLessThanOrEqual(
      geometry.viewportHeight
    );
  });

  // Fullscreen owns a history entry, so the phone's back gesture steps out of
  // it instead of abandoning the file.
  await test.step('back exits fullscreen and keeps the file open', async () => {
    await openDetail();
    await fullscreenButton.click();
    await expect(page).toHaveURL(/fs=true/);

    await page.evaluate(() => window.history.back());

    await expect(page).not.toHaveURL(/fs=true/);
    await expect(page).toHaveURL(/fileId=/);
    await expect(page.getByText('File name:').first()).toBeVisible();
    await expect(overlay).toHaveCount(0);
  });

  // Regression: React reused the same <img> across a file change and only
  // swapped src, so the browser kept painting the previous file until the new
  // one decoded — the old image visibly flashed back after every swipe.
  await test.step('swiping remounts the media instead of reusing it', async () => {
    await openDetail();
    await page.evaluate(() => {
      const img = document.querySelector(
        '.file-detail-panel-current .file-detail-media'
      ) as HTMLImageElement;
      img.dataset.probeTag = 'pre-swipe';
    });
    const before = page.url();

    await swipeLeft(page);
    await expect.poll(() => page.url()).not.toBe(before);

    const state = await page.evaluate(() => {
      const img = document.querySelector(
        '.file-detail-panel-current .file-detail-media'
      ) as HTMLImageElement;
      const wrap = document.querySelector(
        '.file-detail-panel-current .file-detail-media-wrap'
      ) as HTMLElement;
      return {
        reused: img.dataset.probeTag === 'pre-swipe',
        poster: getComputedStyle(wrap).getPropertyValue('--file-detail-poster')
      };
    });
    expect(state.reused).toBe(false);
    // The cached thumbnail stands in while the original decodes.
    expect(state.poster).toContain('/thumbnails/');
  });

  // Two regressions in one contract. The wrap used to have no intrinsic size
  // until the original loaded, so it collapsed to zero between files and the
  // thumbnail placeholder had nowhere to paint (822ms of empty screen per
  // swipe). Reserving a fixed height instead fixed the collapse but reserved
  // the wrong *shape*, so the picture visibly resized — black bars appearing
  // and vanishing — once the original arrived. The box must therefore be
  // non-zero while loading AND the same size afterwards.
  await test.step('media box keeps one size across the load', async () => {
    let releaseOriginal = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseOriginal = resolve;
    });
    await page.route('**/files/*/content', async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await openDetail();
      await swipeLeft(page);
      await page.waitForTimeout(400);

      const wrap = page.locator(
        '.file-detail-panel-current .file-detail-media-wrap'
      );
      const whileLoading = await wrap.boundingBox();
      expect(whileLoading).not.toBeNull();
      // Did not collapse: an unloaded <img> is 0x0 and would take the box
      // down with it.
      expect(whileLoading!.height).toBeGreaterThan(0);

      releaseOriginal();
      const natural = await expect
        .poll(() =>
          page.evaluate(() => {
            const img = document.querySelector(
              '.file-detail-panel-current .file-detail-media'
            ) as HTMLImageElement | null;
            return img?.complete && img.naturalWidth > 0
              ? img.naturalWidth / img.naturalHeight
              : null;
          })
        )
        .not.toBeNull()
        .then(() =>
          page.evaluate(() => {
            const img = document.querySelector(
              '.file-detail-panel-current .file-detail-media'
            ) as HTMLImageElement;
            return img.naturalWidth / img.naturalHeight;
          })
        );

      // Reserved in the file's own shape, so the placeholder is letterboxed
      // exactly like the original and nothing resizes when it arrives.
      expect(whileLoading!.width / whileLoading!.height).toBeCloseTo(
        natural,
        1
      );
      const loaded = await wrap.boundingBox();
      expect(loaded!.height).toBeCloseTo(whileLoading!.height, 0);
    } finally {
      releaseOriginal();
      await page.unroute('**/files/*/content');
    }
  });

  await test.step('swiping works inside fullscreen and stays there', async () => {
    await openDetail();
    await fullscreenButton.click();
    await expect(page).toHaveURL(/fs=true/);
    const before = page.url();

    await swipeLeft(page);

    await expect.poll(() => page.url()).not.toBe(before);
    await expect(page).toHaveURL(/fs=true/);
    await expect(overlay).toBeVisible();
  });

  // Regression: the fullscreen control lived inside the current panel, so it
  // travelled with the swipe — and each neighbouring panel carried its own
  // copy, which mid-gesture showed the "enter fullscreen" icon while already
  // in fullscreen.
  await test.step('fullscreen control is fixed to the screen', async () => {
    await openDetail();
    await fullscreenButton.click();
    await expect(page).toHaveURL(/fs=true/);

    const control = page.locator(
      '.file-detail-frame > .file-detail-fullscreen-btn'
    );
    await expect(control).toHaveCount(1);
    await expect(
      page.locator('.file-detail-panel .file-detail-fullscreen-btn:visible')
    ).toHaveCount(0);

    // The track is the only thing that moves, so staying outside it is what
    // keeps the control still — assert the structure rather than sampling a
    // half-finished gesture, which is timing-dependent.
    const outsideTrack = await page.evaluate(() => {
      const btn = document.querySelector(
        '.file-detail-frame > .file-detail-fullscreen-btn'
      );
      return Boolean(btn && !btn.closest('.file-detail-track'));
    });
    expect(outsideTrack).toBe(true);
  });

  // Regression: the off-screen prev/next preview panels pointed at
  // /files/:id/content — the original file — so opening one image pulled
  // three full-size downloads, and every swipe pulled more.
  await test.step('only the active file is fetched at full size', async () => {
    await gotoGallery();

    const fullSizeRequests: string[] = [];
    page.on('request', (request) => {
      if (/\/files\/[^/]+\/content/.test(request.url())) {
        fullSizeRequests.push(request.url());
      }
    });

    await tiles.nth(1).click();
    await expect(page.getByText('File name:').first()).toBeVisible();
    // Let the neighbouring preview panels settle before counting.
    await expect
      .poll(() => fullSizeRequests.length, { timeout: 5_000 })
      .toBeGreaterThan(0);

    expect(new Set(fullSizeRequests).size).toBe(1);
  });
});
