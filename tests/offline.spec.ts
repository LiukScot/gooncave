import { expect, test, type Page } from '@playwright/test';

import { thumbnailablePng, uploadSampleImages } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

// A deleted file's name and content stay taken in the trash, so each test brings its own.
let HERE = '';
let AWAY = '';
const uniquePng = (name: string) =>
  Buffer.concat([Buffer.from(thumbnailablePng, 'base64'), Buffer.from(name)]).toString('base64');

// Chromium's own offline switch would also cut the core on localhost, which a real device keeps.
const setOffline = (page: Page, offline: boolean) =>
  page.evaluate((value) => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => !value });
    window.dispatchEvent(new Event(value ? 'offline' : 'online'));
  }, offline);

const tile = (page: Page, name: string) =>
  page.locator('[data-test-id="file-card"]').and(page.locator(`[aria-label*="${name}"]`));

test.beforeEach(async ({ page }) => {
  await page.goto('/app/gallery');
  const stamp = `${Date.now()}`;
  HERE = `offline-here-${stamp}.png`;
  AWAY = `offline-away-${stamp}.png`;
  await uploadSampleImages(page, [HERE], { base64: uniquePng(HERE) });
  await uploadSampleImages(page, [AWAY], { base64: uniquePng(AWAY) });
  // Uploads are on this device; the core's REMOTE rows come only from sync.
  await page.route(/\/files\?/, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { files: { path: string; locationType: string }[] };
    for (const file of body.files) {
      if (file.path.endsWith(AWAY)) file.locationType = 'REMOTE';
    }
    if (route.request().url().includes('location=LOCAL')) {
      body.files = body.files.filter((file) => file.locationType === 'LOCAL');
    }
    // The app drops a list it no longer wants when the connection changes.
    await route.fulfill({ response, json: body }).catch((error: Error) => {
      if (!error.message.includes('already handled')) throw error;
    });
  });
  await page.reload();
  await expect(tile(page, AWAY)).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.unroute(/\/files\?/);
  const response = await page.request.get('/files?limit=500');
  const { files } = (await response.json()) as { files: { id: string; path: string }[] };
  for (const file of files) {
    if (file.path.endsWith(HERE) || file.path.endsWith(AWAY)) await page.request.delete(`/files/${file.id}`);
  }
});

const deepGallery = async (page: Page) => {
  // Every third file is not on the device, so both lists need a second page to reach the reader's file.
  const { files } = (await (await page.request.get('/files?limit=1')).json()) as { files: Record<string, unknown>[] };
  const all = Array.from({ length: 500 }, (_, index) => ({
    ...files[0],
    id: `anchor-${index}`,
    path: `anchor-${index}.png`,
    locationType: index % 3 === 1 ? 'REMOTE' : 'LOCAL'
  }));
  await page.route(/\/files\?/, async (route) => {
    const url = new URL(route.request().url());
    const list = url.searchParams.get('location') === 'LOCAL' ? all.filter((file) => file.locationType === 'LOCAL') : all;
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 200);
    await route.fulfill({ json: { files: list.slice(offset, offset + limit), total: list.length } });
  });
  await page.reload();
  await expect(tile(page, 'anchor-0.png')).toBeVisible();

  // The page grows as it is scrolled, and tiles far from the window are not rendered.
  await expect(async () => {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(tile(page, 'anchor-499.png')).toBeAttached({ timeout: 300 });
  }).toPass();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight * 0.7));
  await expect(page.locator('.gallery-masonry-item[data-index="350"]')).toBeAttached();
};

const firstWholeTile = (page: Page) =>
  page.evaluate(() => {
    const tiles = [...document.querySelectorAll<HTMLElement>('.gallery-masonry-item')]
      .map((element) => ({
        index: Number(element.dataset.index),
        top: element.getBoundingClientRect().top,
        name: element.querySelector('[data-test-id="file-card"]')?.getAttribute('aria-label') ?? ''
      }))
      .filter((candidate) => candidate.top >= 0)
      .sort((a, b) => a.index - b.index);
    return { name: tiles[0].name.match(/anchor-\d+/)?.[0] ?? '', top: tiles[0].top };
  });

const topOf = (page: Page, name: string) =>
  tile(page, `${name}.png`)
    .evaluate((element) => element.closest('.gallery-masonry-item')!.getBoundingClientRect().top);

test('a reader deep in the Gallery stays on the same file when the connection changes', async ({ page }) => {
  await deepGallery(page);
  const before = await firstWholeTile(page);
  const number = Number(before.name.replace('anchor-', ''));
  // A tile away from the device gives way to the next one that is here.
  const here = `anchor-${number % 3 === 1 ? number + 1 : number}`;
  const away = `anchor-${number + ((4 - number % 3) % 3)}.png`;

  await setOffline(page, true);
  await expect.poll(() => topOf(page, here), { timeout: 15_000 }).toBeCloseTo(before.top, -1);
  await expect(tile(page, away)).toHaveCount(0);

  const offline = await firstWholeTile(page);
  await setOffline(page, false);
  await expect(tile(page, away)).toBeAttached({ timeout: 15_000 });
  await expect.poll(() => topOf(page, offline.name), { timeout: 15_000 }).toBeCloseTo(offline.top, -1);
});

test('back from a file opened offline, the reader is on that file after reconnecting', async ({ page }) => {
  await deepGallery(page);
  await setOffline(page, true);
  await expect(tile(page, 'anchor-0.png')).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 15_000 }).toBeGreaterThan(1000);
  await page.waitForTimeout(800);
  const opened = await firstWholeTile(page);
  await tile(page, `${opened.name}.png`).click({ position: { x: 8, y: 8 } });
  await expect(page).toHaveURL(/fileId=/);

  await setOffline(page, false);
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Back to gallery' }).click();
  await expect(page).not.toHaveURL(/fileId=/);
  await expect.poll(() => topOf(page, opened.name), { timeout: 15_000 }).toBeCloseTo(opened.top, -1);
});

test('back from a file opened in a short offline list, the reader is on that file after reconnecting', async ({ page }) => {
  // Everything fits on one screen offline, so the reader never scrolled; online the file is deep in the list.
  const { files } = (await (await page.request.get('/files?limit=1')).json()) as { files: Record<string, unknown>[] };
  const all = Array.from({ length: 300 }, (_, index) => ({
    ...files[0],
    id: `anchor-${index}`,
    path: `anchor-${index}.png`,
    locationType: index >= 250 && index < 252 ? 'LOCAL' : 'REMOTE'
  }));
  await page.route(/\/files\?/, async (route) => {
    const url = new URL(route.request().url());
    const list = url.searchParams.get('location') === 'LOCAL' ? all.filter((file) => file.locationType === 'LOCAL') : all;
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 200);
    await route.fulfill({ json: { files: list.slice(offset, offset + limit), total: list.length } });
  });
  await page.reload();
  await setOffline(page, true);
  await expect(tile(page, 'anchor-251.png')).toBeVisible({ timeout: 15_000 });
  const top = await topOf(page, 'anchor-251');
  await tile(page, 'anchor-251.png').click({ position: { x: 8, y: 8 } });
  await expect(page).toHaveURL(/fileId=/);

  await setOffline(page, false);
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Back to gallery' }).click();
  await expect(tile(page, 'anchor-251.png')).toBeAttached({ timeout: 15_000 });
  await expect.poll(() => topOf(page, 'anchor-251'), { timeout: 15_000 }).toBeCloseTo(top, -1);
});

test('a reader at the top of the Gallery stays there when the connection changes', async ({ page }) => {
  await setOffline(page, true);
  await expect(tile(page, AWAY)).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('a file not on the device leaves the Gallery while offline and comes back on reconnecting', async ({ page }) => {
  await setOffline(page, true);

  await expect(page.getByRole('status').getByText('Offline')).toBeVisible();
  await expect(tile(page, AWAY)).toHaveCount(0);
  await expect(tile(page, HERE)).toBeVisible();

  await setOffline(page, false);
  await expect(tile(page, AWAY)).toBeVisible();
  await expect(page.getByRole('status').getByText('Offline')).toHaveCount(0);

  await setOffline(page, true);
  await tile(page, HERE).click();
  await expect(page).toHaveURL(/fileId=/);
});

test('Explore offers the downloaded files, which narrow the gallery', async ({ page }) => {
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'Explore' }).click();
  await setOffline(page, true);

  await expect(page.getByText(/No signal in the cave/)).toBeVisible();
  await expect(page.getByRole('status').getByText('Offline')).toBeVisible();
  await expect(page.getByRole('status').getByRole('button')).toHaveCount(0);
  const narrowed = page.waitForRequest((request) => request.url().includes('location=LOCAL'));
  await page.getByRole('button', { name: 'Show downloaded files', exact: true }).click();
  await narrowed;

  await expect(page).toHaveURL(/\/app\/gallery/);
  await page.locator('.search-lens').click();
  const toggle = page.locator('.search-panel').getByRole('button', { name: 'Downloaded only' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toBeDisabled();
});

const openInGallery = async (page: Page, name: string) => {
  await tile(page, name).click();
  await expect(page).toHaveURL(/fileId=/);
  await expect.poll(async () => {
    const response = await page.request.get('/read-marks/history');
    const { posts } = (await response.json()) as { posts: { siteId: string }[] };
    return posts.filter((post) => post.siteId === 'library').length;
  }).toBeGreaterThan(0);
  const { files } = (await (await page.request.get('/files?limit=500')).json()) as { files: { id: string; path: string }[] };
  return files.find((file) => file.path.endsWith(name))!.id;
};

const goTo = async (page: Page, view: string) => {
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: view }).click();
};

test('History lists a file opened in the Gallery, not one scrolled past, and still shows offline', async ({ page }) => {
  await page.unroute(/\/files\?/);
  const opened = await openInGallery(page, HERE);
  const { files } = (await (await page.request.get('/files?limit=500')).json()) as { files: { id: string; path: string }[] };
  const passed = files.find((file) => file.path.endsWith(AWAY))!.id;

  await page.goto('/app/explore?feed=history');
  const card = page.locator(`[data-read-key="library:${opened}"]`);
  await expect(card).toBeVisible();
  await expect(page.locator(`[data-read-key="library:${passed}"]`)).toHaveCount(0);

  await setOffline(page, true);
  await expect(page.getByText(/No signal in the cave/)).toHaveCount(0);
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(new RegExp(`fileId=${opened}`));
  await page.getByRole('button', { name: 'Back to History' }).click();
  await expect(page).toHaveURL(/feed=history/);
  await expect(card).toBeVisible();
});

test('offline, History marks an entry whose original is not on the device and does not open it', async ({ page }) => {
  const opened = await openInGallery(page, HERE);
  await page.route(/\/read-marks\/history/, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { posts: { libraryLocation?: string }[] };
    for (const post of body.posts) post.libraryLocation = 'REMOTE';
    // The app drops a list it no longer wants when the connection changes.
    await route.fulfill({ response, json: body }).catch((error: Error) => {
      if (!error.message.includes('already handled')) throw error;
    });
  });
  await page.goto('/app/explore?feed=history');
  const card = page.locator(`[data-read-key="library:${opened}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('[data-test-id="card-offline"]')).toHaveCount(0);

  await setOffline(page, true);
  await expect(card.locator('[data-test-id="card-offline"]')).toBeVisible();
  // Playwright will not click aria-disabled, but a real tap still reaches the button and explains why.
  await card.click({ force: true });
  await expect(page.getByText('This file is not on this device. It opens when you reconnect.')).toBeVisible();
  await expect(page).not.toHaveURL(/fileId=/);

  await setOffline(page, false);
  await expect(card.locator('[data-test-id="card-offline"]')).toHaveCount(0);
});

test('a file opened in the Gallery joins a History list seen earlier', async ({ page }) => {
  await page.unroute(/\/files\?/);
  const first = await openInGallery(page, HERE);
  await page.goBack();
  await goTo(page, 'History');
  await expect(page.locator(`[data-read-key="library:${first}"]`)).toBeVisible();

  await goTo(page, 'Gallery');
  const second = await openInGallery(page, AWAY);
  await page.goBack();
  await goTo(page, 'History');
  await expect(page.locator(`[data-read-key="library:${second}"]`)).toBeVisible();
});

test('loading more of History does not mark its entries again', async ({ page }) => {
  await openInGallery(page, HERE);
  await page.route(/\/read-marks\/history/, async (route) => {
    if (route.request().url().includes('cursor=')) {
      await route.fulfill({ json: { posts: [], nextCursor: null } });
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as object;
    await route.fulfill({ response, json: { ...body, nextCursor: 'next' } });
  });
  await page.goto('/app/explore?feed=history');
  const marks: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/read-marks')) marks.push(request.postData() ?? '');
  });
  const nextPage = page.waitForResponse((response) => response.url().includes('cursor='));
  await page.getByRole('button', { name: 'Load more' }).click();
  await nextPage;
  expect(marks).toEqual([]);
});
