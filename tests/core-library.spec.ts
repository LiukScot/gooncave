import { execFileSync } from 'node:child_process';

import { expect, test } from '@playwright/test';

import type { ExplorePost } from '../frontend/src/api';

import { thumbnailablePng, uploadSampleImages } from './helpers';

const card = (page: import('@playwright/test').Page, name: string) =>
  page.locator(`[data-test-id="file-card"][aria-label*="${name}"]`);

test('a GIF tile releases its ranged video outside the viewport and with reduced motion', async ({ page }) => {
  const name = 'motion-thumbnail.gif';
  const fillers = Array.from({ length: 18 }, (_, i) => `motion-scroll-${i}.png`);
  const fixtureNames = new Set([name, ...fillers]);
  try {
    await page.setViewportSize({ width: 800, height: 450 });
    // Give the scrolling fixtures a separate hash from the other tests' upload.
    const filler = Buffer.concat([Buffer.from(thumbnailablePng, 'base64'), Buffer.from('motion-scroll')]);
    await uploadSampleImages(page, fillers, { base64: filler.toString('base64') });
    const gif = execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=128x96:rate=15:duration=1',
      '-f', 'gif', 'pipe:1'
    ]);
    const { folders } = await (await page.request.get('/folders')).json();
    const uploaded = await page.request.post(`/folders/${folders[0].id}/uploads`, {
      multipart: { files: { name, mimeType: 'image/gif', buffer: gif } }
    });
    expect(uploaded.ok()).toBeTruthy();
    expect((await uploaded.json()).rejected).toEqual([]);

    await page.goto('/app/gallery');
    const tile = card(page, name);
    await expect(tile.locator('img')).toHaveAttribute('src', /-motion\.jpg$/);
    const video = tile.locator('video');
    // Fetched whole, like Explore's previews, and played from memory.
    await expect(video).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
    const poster = await tile.locator('img').getAttribute('src');
    const response = await page.request.get(`${poster}?motion=1`, {
      headers: { Range: 'bytes=0-3' }
    });
    expect(response.status()).toBe(206);
    expect(response.headers()['content-type']).toBe('video/webm');
    expect((await response.body()).toString('hex')).toBe('1a45dfa3');

    const belowTile = await tile.evaluate((element) => element.getBoundingClientRect().bottom + 80);
    await page.evaluate((top) => window.scrollTo(0, top), belowTile);
    await expect.poll(() => tile.evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThan(-64);
    await expect(video).toHaveCount(0);
    await expect(tile.locator('img')).toHaveCount(1);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(video).toHaveCount(1);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(video).toHaveCount(0);
    await expect(tile.locator('img')).toBeVisible();
  } finally {
    const response = await page.request.get('/files?limit=500');
    expect(response.ok()).toBeTruthy();
    const { files } = await response.json() as { files: Array<{ id: string; path: string }> };
    for (const file of files) {
      if (fixtureNames.has(file.path.split('/').pop() ?? '')) {
        expect((await page.request.delete(`/files/${file.id}`)).ok()).toBeTruthy();
      }
    }
  }
});

test('a provider-only GIF plays over an existing still poster in the phone Gallery', async ({ page }) => {
  const preview = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=15:duration=1',
    '-c:v', 'libvpx-vp9', '-f', 'webm', 'pipe:1'
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/\/files\?/, async (route) => {
    const response = await route.fetch();
    const { files } = await response.json();
    const still = files.find((file: { path: string }) => file.path.endsWith('/landscape.png'));
    await route.fulfill({ json: {
      files: still ? [{ ...still, path: 'provider-only', locationType: 'REMOTE', providerGif: true }] : [],
      total: still ? 1 : 0
    } });
  });
  await page.route(/\/thumbnails\/[^?]+\.jpg\?motion=1$/, (route) =>
    route.fulfill({ body: preview, contentType: 'video/webm' }));
  await page.goto('/app/gallery');
  const tile = card(page, 'provider-only');
  await expect(tile.locator('img')).toHaveAttribute('src', /\.jpg$/);
  await expect.poll(() => tile.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);
});

test('browses the library folder, votes a file and deletes another', async ({ page }) => {
  // Browsing local files must not start remote refresh work.
  const booruCalls: string[] = [];
  page.on('request', (request) => {
    if (/\/tags\/refresh|\/explore\/subscriptions\/refresh/.test(request.url())) booruCalls.push(request.url());
  });
  const original = await (await page.request.get('/settings/extra')).json();
  const vote = await page.request.put('/settings/extra', { data: { voteSystemEnabled: true } });
  expect(vote.ok(), 'failed to enable votes').toBeTruthy();
  try {
    // The playwright config put these two files in the library folder before the core started.
    await page.goto('/app/gallery');
    await expect(card(page, 'landscape.png')).toBeVisible();
    await expect(card(page, 'clip.mp4')).toBeVisible();
    await expect(card(page, 'landscape.png').locator('img')).toHaveAttribute('src', /\/thumbnails\//);
    await expect(page.getByText('Duplicate stacks unavailable', { exact: false })).toHaveCount(0);

    const uploaded = `portrait-${Date.now()}.png`;
    await uploadSampleImages(page, [uploaded], { base64: thumbnailablePng });
    await page.goto('/app/gallery');
    await card(page, uploaded).click();
    await expect(page).toHaveURL(/fileId=/);
    const votePosted = page.waitForResponse((res) => res.url().includes('/vote') && res.request().method() === 'POST');
    await page.getByRole('button', { name: 'More actions' }).click();
    // The one action that loses something comes last.
    await expect(page.locator('.more-actions-pills button').last()).toHaveText('Delete file');
    await page.getByRole('button', { name: 'Vote up' }).click();
    await page.getByRole('button', { name: 'Back to gallery' }).click();
    expect((await votePosted).ok()).toBeTruthy();
    await page.reload();
    const galleryVote = card(page, uploaded).locator('..').getByRole('button', { name: /Votable again in .*; score 1/ });
    await expect(galleryVote).toHaveText('1');

    // The centre of a video tile is its inline play button; the rest of the tile opens the file.
    await card(page, 'clip.mp4').click({ position: { x: 8, y: 8 } });
    await expect(page).toHaveURL(/fileId=/);
    await expect(page.locator('.file-detail-panel-current video')).toBeVisible();
    const deleted = page.waitForResponse((res) => res.request().method() === 'DELETE' && /\/files\/[^/]+$/.test(res.url()));
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('button', { name: 'Delete file' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    expect((await deleted).ok()).toBeTruthy();
    await page.goto('/app/gallery');
    await expect(card(page, uploaded)).toBeVisible();
    await expect(card(page, 'clip.mp4')).toHaveCount(0);
    await expect(page.getByText('Could not update the tags')).toHaveCount(0);
    expect(booruCalls).toEqual([]);
  } finally {
    await page.request.put('/settings/extra', { data: original });
  }
});

test('a file opened from the gallery stays open after a reload', async ({ page }) => {
  await page.goto('/app/gallery');
  await card(page, 'landscape.png').click();
  await expect(page).toHaveURL(/\/app\/gallery\?fileId=/);
  await page.reload();
  await expect(page).toHaveURL(/\/app\/gallery\?fileId=/);
  await expect(page.locator('.file-detail-panel-current').getByText('Added:')).toBeVisible();
});

/** As if landscape.png sat past the first page: the list leaves it out, a lookup by id still finds it. */
const fileOutsideTheLoadedPage = async (page: import('@playwright/test').Page) => {
  const { files } = await (await page.request.get('/files?limit=1000')).json() as { files: Array<{ id: string; path: string }> };
  const target = files.find((file) => file.path.endsWith('landscape.png'));
  if (!target) throw new Error('The library has no landscape.png');
  await page.route('**/files?*', async (route) => {
    if (new URL(route.request().url()).searchParams.has('fileId')) return route.continue();
    const response = await route.fetch();
    const body = await response.json() as { files: Array<{ id: string }> };
    return route.fulfill({ response, json: { ...body, files: body.files.filter((file) => file.id !== target.id) } });
  });
  return target;
};

test('a file outside the loaded gallery page opens from its address', async ({ page }) => {
  const target = await fileOutsideTheLoadedPage(page);
  await page.goto(`/app/gallery?fileId=${target.id}`);
  await expect(page.locator('.file-detail-panel-current').getByText('Added:')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`fileId=${target.id}`));

  await page.goto('/app/gallery?fileId=no-such-file');
  await expect(page.getByText('This file is no longer in your library')).toBeVisible();
  await expect(page).not.toHaveURL(/fileId=/);
  await expect(page.locator('[data-test-id="file-card"]').first()).toBeVisible();
});

test('a file opened from its address can be deleted, and undoing leaves the gallery as it was', async ({ page }) => {
  const target = await fileOutsideTheLoadedPage(page);
  const deletes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE') deletes.push(request.url());
  });
  await page.goto(`/app/gallery?fileId=${target.id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('button', { name: 'Delete file' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page).not.toHaveURL(/fileId=/);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('[data-test-id="file-card"]').first()).toBeVisible();
  await expect(card(page, 'landscape.png')).toHaveCount(0);
  expect(deletes).toEqual([]);
});

test('a file added while the gallery is open shows up without reloading', async ({ page }) => {
  await page.goto('/app/gallery');
  await expect(page.locator('[data-test-id="file-card"]').first()).toBeVisible();
  const added = `outside-${Date.now()}.png`;
  await uploadSampleImages(page, [added], { base64: thumbnailablePng });
  await expect(card(page, added)).toBeVisible({ timeout: 10_000 });
});

test('a file deleted with its undo pending stays out of the gallery while the library changes', async ({ page }) => {
  const deleted = `deleted-${Date.now()}.png`;
  await uploadSampleImages(page, [deleted], { base64: thumbnailablePng });
  await page.goto('/app/gallery');
  await card(page, deleted).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('button', { name: 'Delete file' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  // The viewer moves on to the next file.
  await page.getByRole('button', { name: 'Back to gallery' }).click();
  await expect(page).not.toHaveURL(/fileId=/);

  // The server still lists the file until the undo window ends, and this change refreshes the list.
  const added = `meanwhile-${Date.now()}.png`;
  await uploadSampleImages(page, [added], { base64: thumbnailablePng });
  await expect(card(page, added)).toBeVisible({ timeout: 10_000 });
  await expect(card(page, deleted)).toHaveCount(0);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(card(page, deleted)).toBeVisible();
});

test('a lookup that failed can be tried again, from the message and by coming back to the file', async ({ page }) => {
  const target = await fileOutsideTheLoadedPage(page);
  let down = true;
  await page.route(
    (url) => url.pathname === '/files' && url.searchParams.get('fileId') === target.id,
    (route) => (down ? route.fulfill({ status: 500, json: { error: 'down' } }) : route.fallback())
  );
  const panelOfTarget = page.locator(`.file-detail-panel-current img[src*="${target.id}"]`).first();

  await page.goto(`/app/gallery?fileId=${target.id}`);
  await expect(page.getByText('Could not open this file')).toBeVisible();
  down = false;
  await page.getByRole('button', { name: 'Open the file again' }).click();
  await expect(panelOfTarget).toBeVisible();

  down = true;
  await page.goto('/app/gallery');
  await expect(page.locator('[data-test-id="file-card"]').first()).toBeVisible();
  await page.evaluate((id) => history.pushState(null, '', `/app/gallery?fileId=${id}`), target.id);
  await expect(page.getByText('Could not open this file')).toBeVisible();
  down = false;
  await page.goBack();
  await expect(page).not.toHaveURL(/fileId=/);
  await page.goForward();
  await expect(panelOfTarget).toBeVisible();
});

test('a file asks for its comments only when the reader gets near them', async ({ page }) => {
  let asked = 0;
  await page.route('**/files/*/comments', (route) => {
    asked += 1;
    return route.fulfill({ json: { supported: true, sources: [] } });
  });
  await page.goto('/app/gallery');
  // Far below the fold, whatever the size of the sample picture.
  await page.addStyleTag({ content: '.file-detail-media-wrap { min-height: 3000px; }' });
  await card(page, 'landscape.png').click();
  const below = page.locator('.file-detail-panel-current').getByText('File info');
  await expect(below).toBeAttached();
  await page.waitForLoadState('networkidle');
  expect(asked).toBe(0);

  // The section right below the comments stays off screen: they load ahead of the reader.
  // A wheel, as window.scrollTo is undone while the detail still holds the top of the page.
  const distance = await below.evaluate(
    (element) => element.getBoundingClientRect().top - window.innerHeight - 300
  );
  await page.mouse.wheel(0, distance);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(below).not.toBeInViewport();
  await expect.poll(() => asked).toBe(1);
});

test('in fullscreen a pinch zooms, two fingers sliding move the zoomed picture, and dragging pans it instead of dragging the image out', async ({ page }) => {
  await page.goto('/app/gallery');
  await card(page, 'landscape.png').click();
  const wrap = page.locator('.file-detail-panel-current .file-detail-media-wrap');
  await wrap.hover();
  await page.locator('.file-detail-panel-current .file-detail-fullscreen-btn').click();
  await expect(wrap).toHaveClass(/is-fullscreen/);
  await expect(wrap.locator('img')).toBeVisible();
  // The page takes the wheel again once the fullscreen animation has run.
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
  const box = await wrap.boundingBox();
  if (!box) throw new Error('No media to zoom');
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x, center.y);
  // Two fingers sliding on a touchpad: a wheel without Ctrl does not zoom.
  await page.mouse.wheel(0, -600);
  await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0);
  await expect(wrap).not.toHaveClass(/is-zoomed/);
  // A pinch: the touchpad sends it as a wheel with Ctrl held.
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -150);
  await page.keyboard.up('Control');
  await expect(wrap).toHaveClass(/is-zoomed/);
  const zoomed = () => wrap.evaluate((element) => (element as HTMLElement).style.getPropertyValue('--file-detail-zoom'));
  const pinched = await zoomed();
  await page.mouse.wheel(0, 60);
  await expect.poll(zoomed).not.toBe(pinched);
  // The thumbnail under the picture does not zoom, so panning would uncover it.
  expect(await wrap.evaluate((element) => getComputedStyle(element, '::before').display)).toBe('none');
  const zoom = () => wrap.evaluate((element) => (element as HTMLElement).style.getPropertyValue('--file-detail-zoom'));
  const before = await zoom();
  await page.evaluate(() => {
    document.addEventListener('dragstart', (event) => {
      if (!event.defaultPrevented) document.body.setAttribute('data-dragged', 'true');
    });
  });
  await page.mouse.down();
  await page.mouse.move(center.x - 120, center.y - 80, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('body')).not.toHaveAttribute('data-dragged', 'true');
  await expect.poll(zoom).not.toBe(before);
});

test('a file a running sync adds shows up in the gallery while the sync goes on', async ({ page }) => {
  const providers = [{ provider: 'fixture', stage: 'fetching', fetched: 1, total: 2, processed: 1, added: 0, skipped: 0, removed: 0, failed: 0, errors: [] }];
  await page.route('**/favorites/sync/status', (route) => route.fulfill({ json: {
    status: 'running', message: 'Fetching favorites', startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z', progress: { providers }, results: []
  } }));
  await page.goto('/app/gallery');
  await expect(card(page, 'landscape.png')).toBeVisible();

  const synced = `synced-${Date.now()}.png`;
  await uploadSampleImages(page, [synced], { base64: thumbnailablePng });
  providers[0].added = 1;
  await expect(card(page, synced)).toBeVisible();
});

const motionSite = {
  id: 'fixture', name: 'Fixture', engine: 'e621', baseUrl: 'https://fixture.invalid',
  enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
  engineCredentialSchema: 'username+apikey', sortOrder: 0
};
const motionPost: ExplorePost = {
  remoteId: '2', siteId: motionSite.id, siteName: motionSite.name, engine: 'e621',
  previewUrl: '/favicon.png', sampleUrl: null, fileUrl: 'https://fixture.invalid/loop.gif',
  motionThumbnailUrl: '/explore/media/file.gif?motion=1',
  width: 128, height: 96, score: 0, rating: null, md5: null, createdAt: null,
  tags: [], favCount: null, uploader: null, fileExt: 'gif', fileSize: null,
  favorited: false, voted: null, sourceUrl: 'https://fixture.invalid/posts/2',
  parentId: null, hasChildren: false, poolIds: []
};

test('Explore plays a remote GIF preview without loading the original into the grid', async ({ page }) => {
  const preview = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=15:duration=1',
    '-c:v', 'libvpx-vp9', '-f', 'webm', 'pipe:1'
  ]);
  let conversions = 0;
  const originals: string[] = [];
  page.on('request', (request) => {
    if (request.url() === motionPost.fileUrl) originals.push(request.url());
  });
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [motionSite] } }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: {
    posts: [motionPost], siteErrors: [], sites: [motionSite.id]
  } }));
  await page.route('**/explore/media/file.gif?motion=1', (route) => {
    conversions += 1;
    return route.fulfill({ body: preview, contentType: 'video/webm' });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/app/explore');
  const tile = page.getByRole('button', { name: /Open post 2 from Fixture/ });
  await expect(tile.locator('img')).toHaveAttribute('src', /favicon\.png$/);
  expect(conversions).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => tile.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);
  expect(conversions).toBe(1);
  expect(originals).toEqual([]);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(tile.locator('video')).toHaveCount(0);
  await expect(tile.locator('img')).toBeVisible();
});

test('a post link typed in Explore search opens that post, and Back returns to the results', async ({ page }) => {
  const linked = { ...motionPost, remoteId: '77', motionThumbnailUrl: null, fileUrl: 'https://fixture.invalid/f/77.png', fileExt: 'png', sourceUrl: 'https://fixture.invalid/posts/77' };
  const searched: string[] = [];
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [motionSite] } }));
  await page.route('**/explore/posts?*', (route) => {
    searched.push(new URL(route.request().url()).searchParams.get('tags') ?? '');
    return route.fulfill({ json: { posts: [motionPost], siteErrors: [], sites: [motionSite.id] } });
  });
  await page.route('**/explore/post?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    expect([params.get('siteId'), params.get('remoteId')]).toEqual([motionSite.id, '77']);
    return route.fulfill({ json: { post: linked } });
  });
  await page.goto('/app/explore');
  await expect(page.getByRole('button', { name: /Open post 2 from Fixture/ })).toBeVisible();
  await page.locator('.search-lens').click();
  const box = page.locator('#explore-tag-search');
  await box.fill('https://www.fixture.invalid/posts/77/');
  await box.press('Enter');
  await expect(page).toHaveURL(/post=[^&]*77/);
  await expect(page.getByRole('group', { name: 'Post actions' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Search and filter Explore' })).toBeHidden();
  // The link is not searched as a tag.
  expect(searched.some((tags) => tags.includes('fixture.invalid'))).toBe(false);
  await page.goBack();
  await expect(page).toHaveURL(/\/app\/explore(?!.*post=)/);
  await expect(page.getByRole('button', { name: /Open post 2 from Fixture/ })).toBeVisible();
});

test('an Explore tile without a known size keeps its height while it is away', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // FurAffinity and some feeds give no dimensions: the tile takes its picture's height, and a
  // tile far from the screen swaps its picture for an empty box of that height. Any difference
  // moves every tile below it while the reader scrolls.
  const posts = Array.from({ length: 60 }, (_, i) => ({
    ...motionPost,
    remoteId: String(100 + i),
    previewUrl: `https://fixture.invalid/p/${i}.svg`,
    fileUrl: `https://fixture.invalid/f/${i}.png`,
    motionThumbnailUrl: null,
    fileExt: 'png',
    width: i === 0 ? null : 600,
    height: i === 0 ? null : 800,
    sourceUrl: `https://fixture.invalid/posts/${100 + i}`
  }));
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [motionSite] } }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: {
    posts, siteErrors: [], sites: [motionSite.id]
  } }));
  await page.route('https://fixture.invalid/p/**', (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840"><rect width="100%" height="100%" fill="#4a8"/></svg>'
  }));
  await page.goto('/app/explore');
  const tile = page.locator('.explore-thumb', { has: page.getByRole('button', { name: /Open post 100 from Fixture/ }) });
  const picture = tile.locator('img.gallery-thumb-img');
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  const height = () => tile.evaluate((element) => element.getBoundingClientRect().height);
  const shown = await height();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(tile.locator('[data-test-id="explore-card-placeholder"]')).toBeAttached();
  expect(await height()).toBe(shown);
});

test('Explore asks once for a remote GIF preview the core cannot make', async ({ page }) => {
  let conversions = 0;
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [motionSite] } }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: {
    posts: [motionPost], siteErrors: [], sites: [motionSite.id]
  } }));
  await page.route('**/explore/media/file.gif?motion=1', (route) => {
    conversions += 1;
    return route.fulfill({ status: 502, json: { error: 'The animated preview is too large.' } });
  });
  await page.goto('/app/explore');
  const tile = page.getByRole('button', { name: /Open post 2 from Fixture/ });
  await expect.poll(() => conversions).toBe(1);
  // Leaving and coming back must not make the core download and convert the GIF again.
  const settle = () => page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settle();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await settle();
  await page.waitForTimeout(500);
  expect(conversions).toBe(1);
  await expect(tile.locator('video')).toHaveCount(0);
});

test('a post the person unfavorites is not favorited again as a matched copy', async ({ page }) => {
  const post: ExplorePost = {
    remoteId: '1', siteId: 'fixture', siteName: 'Fixture', engine: 'e621',
    previewUrl: '/favicon.png', sampleUrl: null, fileUrl: '/favicon.png',
    width: 640, height: 480, score: 0, rating: null, md5: null, createdAt: null,
    tags: [{ tag: 'fixture_artist', category: 'artist' }], favCount: null, uploader: null,
    fileExt: 'png', fileSize: null, favorited: true, voted: null,
    sourceUrl: 'https://fixture.invalid/posts/1', parentId: null, hasChildren: false,
    poolIds: [],
    // Its own saved copy: the match goes stale once the favorite is removed.
    galleryFavoriteMatch: true
  };
  const favorites: string[] = [];
  await page.route('**/duplicates/settings', (route) => route.fulfill({ json: { enabled: true, style: 'favorite_all', preferredProviders: [] } }));
  await page.route('**/booru-sites', (route) => route.fulfill({ json: { sites: [{
    id: 'fixture', name: 'Fixture', engine: 'e621', baseUrl: 'https://fixture.invalid',
    enabled: true, username: 'fixture', hasApiKey: true, hasSessionCookie: false,
    engineCredentialSchema: 'username+apikey', sortOrder: 0
  }] } }));
  await page.route('**/explore/posts?*', (route) => route.fulfill({ json: { posts: [post], siteErrors: [], sites: ['fixture'] } }));
  await page.route(/\/explore\/post(?:-tags|-text|-relations|-pools)?\?/, (route) => route.fulfill({ json: {
    post, tags: post.tags, title: null, description: null, parent: null, children: [], pools: []
  } }));
  const unfavorites: string[] = [];
  await page.route('**/explore/unfavorite', (route) => {
    unfavorites.push(route.request().postData() ?? '');
    return route.fulfill({ json: { ok: true, removedLocalFile: true } });
  });
  await page.route('**/explore/favorite', (route) => {
    favorites.push(route.request().postData() ?? '');
    return route.fulfill({ json: { ok: true, fileId: 'fixture-file', voteError: null } });
  });
  await page.goto('/app/explore');
  await page.getByRole('button', { name: 'Open post 1 from Fixture', exact: false }).click();
  // Scoped: the heart on the grid's card has the same name, and it is the only match until the post opens.
  const actions = page.getByRole('group', { name: 'Post actions' });
  await actions.getByRole('button', { name: 'Remove from favorites' }).click();
  await expect.poll(() => unfavorites.length).toBe(1);
  // Long enough for an automatic favorite to go out, were one queued.
  await page.waitForTimeout(2_000);
  expect(favorites).toEqual([]);
  await expect(actions.getByRole('button', { name: 'Favorite and save' })).toBeVisible();
});

test('double-clicking the picture opens fullscreen without selecting it', async ({ page }) => {
  await page.goto('/app/gallery');
  await card(page, 'landscape.png').click();
  const picture = page.locator('.file-detail-panel-current .file-detail-media-wrap img');
  await expect(picture).toBeVisible();
  // Headless Chromium does not paint a double-clicked image as selected, so
  // check the rule that stops it.
  await expect(picture).toHaveCSS('user-select', 'none');
  await picture.dblclick();
  await expect(page.locator('.file-detail-panel-current .file-detail-media-wrap')).toHaveClass(/is-fullscreen/);
});

test('the ring around the chosen source is whole on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route('**/files/*/source-text', (route) => route.fulfill({ json: { sources: [
    { siteName: 'One', sourceUrl: 'https://one.invalid/post/1', title: null, description: 'First' },
    { siteName: 'Two', sourceUrl: 'https://two.invalid/post/2', title: null, description: 'Second' }
  ] } }));
  await page.goto('/app/gallery');
  await card(page, 'landscape.png').click();
  const chosen = page.locator('.file-detail-panel-current .file-detail-source-pick[aria-pressed="true"]');
  await chosen.scrollIntoViewIfNeeded();
  const cut = await chosen.evaluate((button) => {
    const ring = button.firstElementChild!.getBoundingClientRect();
    const reach = parseFloat(getComputedStyle(button.firstElementChild!).boxShadow.split(' ').at(-1)!);
    for (let parent = button.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX === 'visible' && !/paint|content|strict/.test(style.contain)) continue;
      const box = parent.getBoundingClientRect();
      if (ring.left - reach < box.left) return parent.className;
    }
    return null;
  });
  expect(cut).toBeNull();
});
