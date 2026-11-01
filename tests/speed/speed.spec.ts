import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';

import type { ExplorePost } from '../../frontend/src/api';

import standards from './standards.json';

const SAMPLES = 5;
// Requests a screen starts after its pictures, such as a status poll, count too.
const SETTLE_MS = 1_000;
const WAIT_MS = 15_000;
// The 250 pictures and the clip that playwright.config.ts puts in the library.
const LIBRARY_FILES = 251;

const METRICS = ['firstContentMs', 'lastThumbnailMs', 'requests', 'siteRequests', 'failedRequests', 'slowestRequestMs'] as const;
// What the core answers by asking a booru, which serves one request at a time: each extra one delays the rest.
const SITE_REQUEST = /^\/explore\/(post|posts|pool)(-|$)|^\/files\/[^/]+\/(relations|pools|comments|source-text)$/;
type Metric = typeof METRICS[number];
type Measured = Partial<Record<Metric, number>>;
type RecordedRequest = { path: string; status: number; durationMs: number };

type Screen = {
  name: string;
  url: string;
  /** Visible once the screen shows what it is for. */
  content: string;
  /** Each of these on screen must end with a picture. */
  tiles?: string;
  /** The title shows before the contents, which say "Loading" until they arrive. */
  loadsBehindGate?: boolean;
  /** What the person clicks once the page has loaded, for a screen no address opens. */
  click?: string;
};

const settings = (name: string, slug: string): Screen => ({
  name: `settings-${name}`,
  url: `/app/settings/${slug}`,
  content: 'h1',
  loadsBehindGate: true
});

const SCREENS: Screen[] = [
  { name: 'gallery', url: '/app/gallery', content: '[data-test-id="file-card"]', tiles: '[data-test-id="file-card"]' },
  { name: 'explore', url: '/app/explore', content: '[data-test-id="explore-card"]', tiles: '[data-test-id="explore-card"]' },
  {
    name: 'file-detail',
    url: '/app/gallery',
    click: '[data-test-id="file-card"][aria-label*=".jpg"]',
    content: '.file-detail-panel-current .file-detail-media-wrap',
    tiles: '.file-detail-panel-current .file-detail-media-wrap'
  },
  {
    name: 'explore-post',
    url: '/app/explore',
    click: '[data-test-id="explore-card"][aria-label^="Open post 1 from"]',
    content: '.file-detail-panel-current .file-detail-media-wrap',
    tiles: '.file-detail-panel-current .file-detail-media-wrap'
  },
  { name: 'pool', url: '/app/pool?site=fixture&pool=3', content: '[data-test-id="pool-tile"]', tiles: '[data-test-id="pool-tile"]' },
  { name: 'games', url: '/app/games', content: 'h1' },
  settings('menu', ''),
  settings('file-sources', 'file-sources'),
  settings('duplicates', 'duplicates'),
  settings('accounts', 'accounts'),
  settings('subscriptions', 'subscriptions'),
  settings('shortcuts', 'shortcuts'),
  settings('blacklist', 'blacklist'),
  settings('appearance', 'appearance'),
  settings('sync', 'sync'),
  settings('trash', 'trash'),
  settings('extra', 'extra'),
  settings('report', 'report')
];

const explorePosts: ExplorePost[] = Array.from({ length: 40 }, (_, index) => ({
  remoteId: String(index + 1), siteId: 'fixture', siteName: 'Fixture', engine: 'e621',
  // Served by the core, with a query string so the browser fetches each one like a real preview.
  previewUrl: `/favicon.png?post=${index + 1}`, sampleUrl: null, fileUrl: `/favicon.png?post=${index + 1}`,
  width: 640, height: 480, score: 0, rating: null, md5: null, createdAt: null,
  tags: [{ tag: 'fixture_artist', category: 'artist' }], favCount: null, uploader: null,
  fileExt: 'png', fileSize: null, favorited: false, voted: null,
  sourceUrl: `https://fixture.invalid/posts/${index + 1}`, hasChildren: false,
  // The first post has everything a detail view can ask a site for.
  parentId: index === 0 ? '100' : null, poolIds: index === 0 ? ['3'] : [], description: index === 0 ? 'Fake text' : null
}));

// A booru answers from the internet, so its time says nothing about this code.
async function mockBooru(page: Page, origin: string) {
  // Site logos and the like: the internet's speed is not this code's, and CI may not reach it.
  await page.route((url) => url.origin !== origin, (route) => route.fulfill({ contentType: 'image/png', body: Buffer.alloc(0) }));
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [{
    id: 'fixture', name: 'Fixture', engine: 'e621', baseUrl: 'https://fixture.invalid',
    enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
    engineCredentialSchema: 'username_api_key', sortOrder: 0
  }] } }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: { posts: explorePosts, siteErrors: [], sites: ['fixture'] } }));
  await page.route('**/explore/pool?*', (route) => route.fulfill({ json: {
    siteId: 'fixture', poolId: '3', siteName: 'Fixture', name: 'Fixture pool', postCount: explorePosts.length, page: 1,
    pageSize: explorePosts.length, postIds: explorePosts.map((post) => post.remoteId),
    posts: explorePosts.map((post, index) => ({ ...post, position: index + 1, localFileId: null }))
  } }));
  await page.route('**/explore/post-relations?*', (route) => route.fulfill({ json: { posts: [] } }));
  await page.route('**/explore/post-pools?*', (route) => route.fulfill({ json: { pools: [] } }));
  await page.route('**/explore/post-comments?*', (route) => route.fulfill({ json: { supported: true, comments: [] } }));
}

function waitForContent(page: Page, { content, loadsBehindGate }: Screen) {
  return page.waitForFunction(([selector, gated]) => {
    const element = document.querySelector(selector);
    const shown = element && element.getBoundingClientRect().height > 0 && !(gated && document.body.textContent?.includes('Loading'));
    return shown ? performance.now() : null;
  }, [content, loadsBehindGate] as const, { polling: 'raf', timeout: WAIT_MS }).then((handle) => handle.jsonValue() as Promise<number>);
}

function waitForPictures(page: Page, tiles: string) {
  return page.waitForFunction((selector) => {
    const onScreen = [...document.querySelectorAll(selector)].filter((tile) => {
      const box = tile.getBoundingClientRect();
      return box.bottom > 0 && box.top < innerHeight && box.height > 0;
    });
    return onScreen.length > 0 && onScreen.every((tile) => tile.querySelector('img')?.complete ?? true);
  }, tiles, { polling: 'raf', timeout: WAIT_MS });
}

// A tile can appear after the first ones have loaded, so this reads the network
// time of whatever is on screen at the end, not the moment the wait ended.
function readPictures(page: Page, tiles: string) {
  return page.evaluate((selector) => {
    const onScreen = [...document.querySelectorAll(selector)].filter((tile) => {
      const box = tile.getBoundingClientRect();
      return box.bottom > 0 && box.top < innerHeight && box.height > 0;
    });
    const images = onScreen.map((tile) => tile.querySelector('img'));
    return {
      blank: images.filter((image) => !image || image.naturalWidth === 0).map((image) => image?.alt ?? 'tile without a picture'),
      lastLoadedMs: Math.max(0, ...images.flatMap((image) =>
        image ? performance.getEntriesByName(image.src).map((entry) => (entry as PerformanceResourceTiming).responseEnd) : []))
    };
  }, tiles);
}

async function sample(browser: Browser, testInfo: TestInfo, screen: Screen) {
  const { baseURL, viewport, hasTouch, isMobile } = testInfo.project.use;
  // A new context per sample: an empty browser cache, as on a first visit.
  const context = await browser.newContext({ baseURL, viewport, hasTouch, isMobile });
  try {
    const page = await context.newPage();
    await mockBooru(page, new URL(baseURL ?? '').origin);
    const requests: RecordedRequest[] = [];
    page.on('requestfinished', (request) => {
      void (async () => {
        const response = await request.response();
        requests.push({
          path: new URL(request.url()).pathname,
          status: response?.status() ?? 0,
          durationMs: Math.max(0, request.timing().responseEnd)
        });
      })().catch((error: unknown) => {
        console.error(`Could not read the response of ${request.url()}: ${String(error)}`);
      });
    });
    page.on('requestfailed', (request) => {
      requests.push({ path: new URL(request.url()).pathname, status: 0, durationMs: 0 });
    });

    await page.goto(screen.url);
    if (screen.click) await page.locator(screen.click).first().click({ position: { x: 8, y: 8 }, timeout: WAIT_MS });
    const firstContentMs = await waitForContent(page, screen);
    if (screen.tiles) await waitForPictures(page, screen.tiles);
    await page.waitForTimeout(SETTLE_MS);
    const measured: Measured = { firstContentMs };
    let blank: string[] = [];
    if (screen.tiles) {
      await waitForPictures(page, screen.tiles);
      const pictures = await readPictures(page, screen.tiles);
      measured.lastThumbnailMs = pictures.lastLoadedMs;
      blank = pictures.blank;
    }
    measured.requests = requests.length;
    measured.siteRequests = requests.filter((request) => SITE_REQUEST.test(request.path)).length;
    measured.failedRequests = requests.filter(({ status }) => status === 0 || status >= 400).length;
    measured.slowestRequestMs = Math.max(0, ...requests.map(({ durationMs }) => durationMs));
    return { measured, requests, blank };
  } finally {
    await context.close();
  }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Adds one screen to a JSON file in the test output, which the CI job uploads. */
function record(testInfo: TestInfo, file: string, start: object, key: string, value: unknown) {
  const target = path.join(testInfo.project.outputDir, file);
  const existing = (fs.existsSync(target)
    ? JSON.parse(fs.readFileSync(target, 'utf8'))
    : { ...start, screens: {} }) as { screens: Record<string, unknown> };
  existing.screens = Object.fromEntries(Object.entries({ ...existing.screens, [key]: value }).sort());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(existing, null, 2)}\n`);
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  // Thumbnails are made in the background: a screen measured before they exist times that work instead.
  await expect.poll(async () => {
    const response = await request.get(`/files?limit=${LIBRARY_FILES}`);
    if (!response.ok()) return `HTTP ${response.status()}`;
    const { files } = await response.json() as { files: Array<{ thumbUrl: string | null }> };
    return files.filter((file) => file.thumbUrl).length;
  }, { message: 'the library never finished making its thumbnails', timeout: 280_000 }).toBe(LIBRARY_FILES);
});

for (const screen of SCREENS) {
  test(screen.name, async ({ browser }, testInfo) => {
    const key = `${testInfo.project.name}/${screen.name}`;
    const samples = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      samples.push(await sample(browser, testInfo, screen));
    }

    const result: Measured = {};
    for (const metric of METRICS) {
      const values = samples.flatMap(({ measured }) => measured[metric] ?? []);
      if (values.length > 0) result[metric] = Math.round(median(values));
    }
    record(testInfo, 'speed-standards.json', { tolerances: standards.tolerances }, key, result);
    record(testInfo, 'speed-requests.json', {}, key, samples[samples.length - 1].requests);

    const standard = (standards.screens as Record<string, Measured>)[key];
    const problems: string[] = [];
    const blank = [...new Set(samples.flatMap((run) => run.blank))];
    if (blank.length > 0) problems.push(`${key}: thumbnails without a picture: ${blank.join(', ')}`);
    if (!standard) problems.push(`${key}: no standard yet, measured ${JSON.stringify(result)}`);
    for (const metric of METRICS) {
      const measured = result[metric];
      const expected = standard?.[metric];
      if (measured === undefined || expected === undefined) continue;
      const limit = expected + standards.tolerances[metric];
      console.log(`${key} ${metric}: ${measured} (standard ${expected}, limit ${limit})`);
      if (measured > limit) problems.push(`${key} ${metric}: measured ${measured}, standard ${expected}, limit ${limit}`);
    }
    if (problems.length > 0) throw new Error(problems.join('\n'));
  });
}
