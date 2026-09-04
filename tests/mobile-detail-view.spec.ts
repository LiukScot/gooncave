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
  // The gallery sort is persisted in localStorage and the suite shares one
  // browser profile, so a spec that left it on "random" would reshuffle the
  // grid on every load and nothing here could rely on tile order.
  await page.goto('/app/gallery');
  await page.evaluate(() =>
    localStorage.setItem('imagesearch.gallerySort', 'mtime_desc')
  );

  const gotoGallery = async () => {
    await page.goto('/app/gallery');
    await expect.poll(() => tiles.count()).toBeGreaterThanOrEqual(3);
  };
  const openDetail = async () => {
    await gotoGallery();
    await tiles.nth(1).click();
    await expect(page).toHaveURL(/\/app\/gallery\?fileId=/);
    await expect(
      page.locator('.file-detail-panel-current').getByText('File name:')
    ).toBeVisible();
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
    await expect(
      page.locator('.file-detail-panel-current').getByText('File name:')
    ).toBeVisible();
    await expect(overlay).toHaveCount(0);
  });

  // Regression: the preview panels kept their own copy of the vote block
  // markup and silently went on rendering the previous design after the panel
  // changed, so mid-swipe the arrows showed as bare glyphs with no button
  // chrome. Both sides render the same component now.
  await test.step('the swipe preview renders the same vote control as the panel', async () => {
    await openDetail();
    const chrome = '.file-detail-vote .btn.file-detail-icon-button';
    // A fresh upload sits at zero, so only the up arrow is offered.
    await expect(
      page.locator(`.file-detail-panel-current ${chrome}`)
    ).toHaveCount(1);
    await expect
      .poll(() => page.locator(`.file-detail-panel-preview ${chrome}`).count())
      .toBeGreaterThanOrEqual(1);
  });

  // The preview panels used to say "Tags load when this file becomes active",
  // because they had no data for the neighbour. They render its real tags and
  // matches now, fetched while the current file is open.
  await test.step("the swipe preview shows the neighbour's tags", async () => {
    // Tag every file this spec uploaded rather than guessing which one ends
    // up next to the opened one: the suite shares a database and a browser
    // profile, so grid order is not stable enough to pin a single neighbour.
    // The afterEach hook deletes these files, tags included.
    const listed = await page.request.get('/files?limit=500');
    expect(listed.ok(), 'failed to list files').toBeTruthy();
    const { files } = (await listed.json()) as {
      files: { id: string; path: string }[];
    };
    const mine = new Set(uploadedNames);
    const ours = files.filter((file) =>
      mine.has(file.path.split('/').pop() ?? '')
    );
    expect(ours.length).toBe(UPLOAD_COUNT);

    const tag = `preview-${Date.now()}`;
    const tagged = await Promise.all(
      ours.map((file) =>
        page.request.post(`/files/${file.id}/tags/manual`, {
          data: { tag, category: 'general' }
        })
      )
    );
    for (const res of tagged) {
      expect(res.ok(), 'failed to tag an uploaded file').toBeTruthy();
    }

    await openDetail();
    // Present, not visible: the neighbour panels are only painted once a
    // gesture starts (see .file-detail-panel-preview in app.css).
    await expect(
      page.locator('.file-detail-panel-next .file-tag-pill', { hasText: tag })
    ).toHaveCount(1);
  });

  // The preview drifted from the panel three separate times — the vote block,
  // the add-tag row, then the score line — each time making the incoming
  // panel jump as the swipe landed. Both sides render the same components
  // now, so the rows they list must match.
  await test.step('the preview renders the same sections as the panel', async () => {
    await openDetail();
    // textContent, not innerText: the preview panels sit outside the frame's
    // clip, and innerText only reports text the browser actually laid out.
    const texts = (root: string, selector: string) =>
      page.evaluate(
        ([panel, target]) =>
          Array.from(document.querySelectorAll(`${panel} ${target}`)).map(
            (el) => (el.textContent ?? '').trim()
          ),
        [root, selector] as const
      );
    const panels = ['.file-detail-panel-next', '.file-detail-panel-prev'];

    // Section headings: a section rendered on one side and not the other
    // makes the incoming panel jump as the swipe lands.
    const titles = await texts(
      '.file-detail-panel-current',
      '.file-detail-section-title'
    );
    expect(titles).toEqual(['File info', 'Tags', 'Sauces']);
    for (const panel of panels) {
      expect(await texts(panel, '.file-detail-section-title')).toEqual(titles);
    }

    // File info rows.
    const rows = await texts(
      '.file-detail-panel-current',
      '.file-detail-info .file-detail-label'
    );
    expect(rows).toContain('Score:');
    for (const panel of panels) {
      expect(
        await texts(panel, '.file-detail-info .file-detail-label')
      ).toEqual(rows);
    }

    // Tag and match bodies. The neighbours hold different files, so only the
    // parts every file renders can be compared: the sources line TagPills
    // always emits, and whatever SauceCards produced — cards or its empty
    // label — rather than nothing at all.
    for (const panel of panels) {
      expect(await texts(panel, '.file-detail-info')).toHaveLength(1);
      const sources = await texts(panel, '.file-detail-label');
      expect(sources).toContain('Sources:');
      const sauces = await page
        .locator(
          `${panel} .file-detail-topmatches-card, ${panel} .file-detail-topmatches-empty`
        )
        .count();
      expect(sauces, 'the preview renders no match section').toBeGreaterThan(0);
    }
  });

  // Issue #284: iOS zooms the page in on any field whose text is under 16px
  // and does not reliably zoom back out. The fields have to carry the size
  // themselves — the viewport meta must keep allowing pinch-zoom.
  await test.step('form fields are large enough not to trigger the iOS zoom', async () => {
    await gotoGallery();
    const sizes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, select, textarea')).map(
        (element) => parseFloat(getComputedStyle(element).fontSize)
      )
    );
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);

    const viewport = await page
      .locator('meta[name="viewport"]')
      .getAttribute('content');
    expect(viewport ?? '').not.toContain('maximum-scale');
  });

  // The box holds a whole query, so completion has to work on the term the
  // caret is in and put its operator back — completing `-mal` to `male`
  // must not drop the `-`.
  await test.step('the search box completes the term being typed', async () => {
    const listed = await page.request.get('/files?limit=500');
    expect(listed.ok(), 'failed to list files').toBeTruthy();
    const { files } = (await listed.json()) as {
      files: { id: string; path: string }[];
    };
    const mine = new Set(uploadedNames);
    const target = files.find((file) =>
      mine.has(file.path.split('/').pop() ?? '')
    );
    expect(target, 'uploaded file missing').toBeTruthy();

    const tag = `suggest${Date.now()}`;
    const tagged = await page.request.post(`/files/${target!.id}/tags/manual`, {
      data: { tag, category: 'general' }
    });
    expect(tagged.ok(), 'failed to tag the uploaded file').toBeTruthy();

    await gotoGallery();
    const box = page.locator('.gallery-tag-search input');
    await box.fill(`-${tag.slice(0, 8)}`);

    const option = page.getByRole('option', { name: new RegExp(tag) });
    await expect(option).toBeVisible();
    await option.click();

    await expect(box).toHaveValue(`-${tag} `);
  });

  // The pen turns every pill into a removable one, and the confirmation
  // names the stored tags it is about to take away — a merged pill stands
  // for several of them, and removing five on one click without saying so
  // reads as a bug.
  await test.step('the pen removes a tag after naming it', async () => {
    const listed = await page.request.get('/files?limit=500');
    expect(listed.ok(), 'failed to list files').toBeTruthy();
    const { files } = (await listed.json()) as {
      files: { id: string; path: string }[];
    };
    const mine = new Set(uploadedNames);
    const target = files.find((file) =>
      mine.has(file.path.split('/').pop() ?? '')
    );
    expect(target, 'uploaded file missing').toBeTruthy();

    const tag = `pen-${Date.now()}`;
    const tagged = await page.request.post(`/files/${target!.id}/tags/manual`, {
      data: { tag, category: 'general' }
    });
    expect(tagged.ok(), 'failed to tag the uploaded file').toBeTruthy();

    await gotoGallery();
    await page.goto(`/app/gallery?fileId=${target!.id}`);
    const pill = page.locator('.file-detail-panel-current .file-tag-pill', {
      hasText: tag
    });
    await expect(pill).toBeVisible();
    // No remove control until the pen is pressed.
    await expect(
      page.locator('.file-detail-panel-current .file-tag-remove')
    ).toHaveCount(0);

    await page
      .locator('.file-detail-panel-current .file-detail-edit-tags-button')
      .click();
    await pill.locator('.file-tag-remove').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(tag);
    await dialog.getByRole('button', { name: 'Remove' }).click();

    await expect(pill).toHaveCount(0);
  });

  // Regression: the delete button pruned the file from the gallery list up
  // front, without waiting for the confirmation. Backing out of the dialog
  // left the open file missing from the list, so its index read -1, both
  // neighbours resolved to null and swiping stopped navigating.
  await test.step('cancelling a delete leaves the file swipeable', async () => {
    const fileIdNow = () => new URL(page.url()).searchParams.get('fileId');
    await openDetail();
    const opened = fileIdNow();

    await page
      .locator('.file-detail-panel-current .file-detail-delete-button')
      .click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await swipeLeft(page);
    await expect.poll(fileIdNow).not.toBe(opened);
  });

  // Regression: swiping inside fullscreen replaces the top history entry
  // only, so the entry underneath still named the file fullscreen was entered
  // on. Backing out of fullscreen popped to it and dragged the view to that
  // stale file instead of staying on the one just swiped to.
  await test.step('leaving fullscreen keeps the file swiped to inside it', async () => {
    const fileIdNow = () => new URL(page.url()).searchParams.get('fileId');
    await openDetail();
    const entered = fileIdNow();
    await fullscreenButton.click();
    await expect(page).toHaveURL(/fs=true/);

    await swipeLeft(page);
    await expect.poll(fileIdNow).not.toBe(entered);
    const swipedTo = fileIdNow();

    await page.evaluate(() => window.history.back());

    await expect(page).not.toHaveURL(/fs=true/);
    await expect.poll(fileIdNow).toBe(swipedTo);
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
      // Wait for the swipe's CSS transition to actually finish (rather than
      // a fixed sleep, which reads a stale box on a slow runner and wastes
      // time on a fast one) before treating .file-detail-panel-current as
      // the swiped-to panel.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .querySelector('.file-detail-track')
                ?.classList.contains('is-transitioning') ?? false
          )
        )
        .toBe(false);

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
    await expect(
      page.locator('.file-detail-panel-current').getByText('File name:')
    ).toBeVisible();
    // Let the neighbouring preview panels settle before counting.
    await expect
      .poll(() => fullSizeRequests.length, { timeout: 5_000 })
      .toBeGreaterThan(0);

    expect(new Set(fullSizeRequests).size).toBe(1);
  });

  // Regression: the confirmation opened behind the fullscreen viewer — an
  // opaque fixed layer sharing the root stacking context with it — so the
  // delete button in there looked dead.
  //
  // Asserted on paint order rather than by clicking: a modal turns off
  // pointer events on the body, so hit-testing skips whatever covers the
  // dialog and both the click and a visibility check pass either way.
  await test.step('the delete confirmation paints above the fullscreen viewer', async () => {
    await openDetail();
    await fullscreenButton.click();
    await expect(page).toHaveURL(/fs=true/);

    await page
      .locator('.file-detail-overlay-actions button[aria-label^="Delete"]')
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(1);

    const layers = await page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector(selector);
        return element
          ? Number.parseInt(getComputedStyle(element).zIndex, 10)
          : Number.NaN;
      };
      return {
        viewer: read('.file-detail-frame.is-fullscreen'),
        dialog: read('[data-slot="dialog-content"]')
      };
    });
    expect(Number.isNaN(layers.viewer)).toBe(false);
    expect(Number.isNaN(layers.dialog)).toBe(false);
    expect(layers.dialog).toBeGreaterThan(layers.viewer);

    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Cancel' })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.evaluate(() => window.history.back());
    await expect(page).not.toHaveURL(/fs=true/);
  });

  // There is no undelete endpoint, so Undo works by not having sent the
  // delete yet — the file has to still be listed afterwards (issue #305).
  await test.step('undoing a delete keeps the file', async () => {
    await openDetail();
    const opened = new URL(page.url()).searchParams.get('fileId');

    await page
      .locator('.file-detail-panel-current .file-detail-delete-button')
      .click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Undo' }).click();

    const listed = await page.request.get('/files?limit=500');
    expect(listed.ok(), 'failed to list files after undo').toBeTruthy();
    const { files } = (await listed.json()) as { files: { id: string }[] };
    expect(files.map((file) => file.id)).toContain(opened);
  });
});
