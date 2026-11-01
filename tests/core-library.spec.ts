import { expect, test } from '@playwright/test';

import type { ExplorePost } from '../frontend/src/api';

import { thumbnailablePng, uploadSampleImages } from './helpers';

const card = (page: import('@playwright/test').Page, name: string) =>
  page.locator(`[data-test-id="file-card"][aria-label*="${name}"]`);

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
    await page.locator('.file-detail-delete-button').click();
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
  await page.locator('.file-detail-delete-button').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page).not.toHaveURL(/fileId=/);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('[data-test-id="file-card"]').first()).toBeVisible();
  await expect(card(page, 'landscape.png')).toHaveCount(0);
  expect(deletes).toEqual([]);
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
    return route.fulfill({ json: { supported: true, comments: [] } });
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
  await below.evaluate((element) => {
    window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY - window.innerHeight - 300);
  });
  await expect(below).not.toBeInViewport();
  await expect.poll(() => asked).toBe(1);
});

test('dragging a zoomed picture in fullscreen pans it instead of dragging the image out', async ({ page }) => {
  await page.goto('/app/gallery');
  await card(page, 'landscape.png').click();
  const wrap = page.locator('.file-detail-panel-current .file-detail-media-wrap');
  await wrap.hover();
  await page.locator('.file-detail-panel-current .file-detail-fullscreen-btn').click();
  await expect(wrap).toHaveClass(/is-fullscreen/);
  await expect(wrap.locator('img')).toBeVisible();
  const box = await wrap.boundingBox();
  if (!box) throw new Error('No media to zoom');
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, -600);
  await expect(wrap).toHaveClass(/is-zoomed/);
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
