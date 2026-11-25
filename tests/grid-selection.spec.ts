import { inflateSync } from 'node:zlib';

import { barOnCornerRow, fixturePost, selectionPosts as posts, serveFixtureSite, tile } from './gridSelectionFixtures';
import { expect, test } from './helpers';

/** The first row of an 8-bit RGB or RGBA screenshot, as [r, g, b] per pixel. */
const firstRowPixels = (png: Buffer) => {
  const width = png.readUInt32BE(16);
  const step = png[25] === 6 ? 4 : 3;
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const data = inflateSync(Buffer.concat(chunks));
  const filter = data[0];
  const row = Buffer.from(data.subarray(1, 1 + width * step));
  // Without a row above, Up adds nothing and Average and Paeth reduce to the pixel on the left.
  for (let at = step; at < row.length; at += 1) {
    if (filter === 1 || filter === 4) row[at] = (row[at] + row[at - step]) & 255;
    if (filter === 3) row[at] = (row[at] + (row[at - step] >> 1)) & 255;
  }
  return Array.from({ length: width }, (_, x) => [row[x * step], row[x * step + 1], row[x * step + 2]]);
};


test('Ctrl-click selects on desktop and Escape leaves', async ({ page }) => {
  await serveFixtureSite(page);
  await page.goto('/app/explore');
  await tile(page, '1').click({ modifiers: ['Control'] });
  const bar = page.getByRole('toolbar', { name: 'Selection' });
  await expect(bar).toContainText('1 selected');
  await expect(bar.getByRole('button')).toHaveText(['Favorite', 'Vote up', 'Vote down', 'Select all', 'Cancel']);
  expect(await barOnCornerRow(page)).toEqual({
    centredOnButton: true, cornerButtonsHidden: true, endsWhereTheButtonEnds: true, besideTheMenu: true
  });
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
});

test('the selection actions fold into a menu when the window narrows', async ({ page }) => {
  // With stars on the Gallery's row is long enough to stop fitting at 800 pixels.
  const original = await (await page.request.get('/settings/extra')).json();
  expect((await page.request.put('/settings/extra', { data: { starsEnabled: true } })).ok()).toBeTruthy();
  try {
    await page.goto('/app/gallery');
    await page.locator('[data-test-id="file-card"][aria-label*="landscape.png"]').click({ modifiers: ['Control'] });
    const bar = page.getByRole('toolbar', { name: 'Selection' });
    await expect(bar.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await page.setViewportSize({ width: 800, height: 720 });
    await expect(bar.getByRole('button', { name: 'Actions' })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(bar.getByRole('button', { name: 'Select all' })).toBeVisible();
  } finally {
    await page.request.put('/settings/extra', { data: { starsEnabled: original.starsEnabled } });
  }
});

test('selected History entries are removed with one request', async ({ page }) => {
  await serveFixtureSite(page);
  await page.route('**/read-marks/history?*', (route) => route.fulfill({ json: { posts, nextCursor: null } }));
  let removed: unknown = null;
  await page.route('**/read-marks/history/remove', async (route) => {
    removed = route.request().postDataJSON();
    await route.fulfill({ json: { removed: 2 } });
  });
  await page.goto('/app/explore?feed=history');
  await tile(page, '1').click({ modifiers: ['Control'] });
  await tile(page, '2').click();
  const bar = page.getByRole('toolbar', { name: 'Selection' });
  await expect(bar.getByRole('button')).toHaveText(['Remove from History', 'Select all', 'Cancel']);
  await bar.getByRole('button', { name: 'Remove from History' }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(bar).toHaveCount(0);
  expect(removed).toEqual({ entries: ['fixture:1', 'fixture:2'] });
  await expect(tile(page, '1')).toHaveCount(0);
});

test('History asks again for the chosen period and tags', async ({ page }) => {
  await serveFixtureSite(page);
  const asked: URL[] = [];
  await page.route('**/read-marks/history?*', async (route) => {
    asked.push(new URL(route.request().url()));
    await route.fulfill({ json: { posts, nextCursor: null } });
  });
  await page.goto('/app/explore?feed=history');
  await expect(tile(page, '1')).toBeVisible();
  await page.getByRole('button', { name: 'Search History' }).click();
  await page.getByRole('button', { name: 'Last week', exact: true }).click();
  await expect.poll(() => asked.at(-1)?.searchParams.has('since')).toBe(true);
  await page.locator('#history-tag-search').fill('fox');
  await expect.poll(() => asked.at(-1)?.searchParams.get('tags')).toBe('fox');
});

test('Escape in an action’s confirmation closes only the confirmation', async ({ page }) => {
  await serveFixtureSite(page);
  await page.route('**/read-marks/history?*', (route) => route.fulfill({ json: { posts, nextCursor: null } }));
  await page.goto('/app/explore?feed=history');
  await tile(page, '1').click({ modifiers: ['Control'] });
  const bar = page.getByRole('toolbar', { name: 'Selection' });
  await bar.getByRole('button', { name: 'Remove from History' }).click();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  await expect(bar).toContainText('1 selected');
});

test('the corner buttons hide while tiles are selected and come back after', async ({ page }) => {
  await serveFixtureSite(page);
  await page.route('**/read-marks/history?*', (route) => route.fulfill({ json: { posts, nextCursor: null } }));
  await page.goto('/app/explore?feed=history');
  const search = page.getByRole('button', { name: 'Search History' });
  await expect(search).toBeVisible();
  await tile(page, '1').click({ modifiers: ['Control'] });
  await expect(search).toBeHidden();
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(search).toBeVisible();
});

test('a post opened just before it is removed from History does not come back', async ({ page }) => {
  await serveFixtureSite(page);
  await page.route('**/read-marks/history?*', (route) => route.fulfill({ json: { posts, nextCursor: null } }));
  const order: string[] = [];
  await page.route('**/read-marks', async (route) => {
    if (route.request().method() === 'POST') order.push('marked read');
    await route.fulfill({ json: { marked: 1 } });
  });
  await page.route('**/read-marks/history/remove', async (route) => {
    order.push('removed');
    await route.fulfill({ json: { removed: 1 } });
  });
  await page.goto('/app/explore?feed=history');
  await tile(page, '1').click();
  await expect(page).toHaveURL(/post=/);
  await page.goBack();
  // The post's page sinks away as a copy that holds the grid too.
  await expect(page.locator('.page-leaving')).toHaveCount(0);
  await tile(page, '1').click({ modifiers: ['Control'] });
  await page.getByRole('toolbar', { name: 'Selection' }).getByRole('button', { name: 'Remove from History' }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect.poll(() => order).toContain('removed');
  // The read queue waits two seconds before it sends; wait past that.
  await page.waitForTimeout(2500);
  expect(order).toEqual(['marked read', 'removed']);
});

test('a tile joining the selection squares its neighbour\'s corner only as its colour arrives', async ({ page }) => {
  await serveFixtureSite(page);
  await page.goto('/app/explore');
  await tile(page, '1').click({ modifiers: ['Control'] });
  const flows = () => page.evaluate(() => [...document.querySelectorAll('.selection-layer [data-key]')].flatMap((shape) => shape.getAnimations()).length);
  await expect.poll(flows).toBe(0);
  await tile(page, '2').click();
  expect(await flows()).toBe(1);
  // Held at its first frame: the second tile's colour has not left the first tile yet.
  await page.evaluate(() => document.querySelectorAll('.selection-layer [data-key]').forEach((shape) => shape.getAnimations().forEach((animation) => {
    animation.pause();
    animation.currentTime = 0;
  })));
  const first = (await tile(page, '1').boundingBox())!;
  const second = (await tile(page, '2').boundingBox())!;
  const quarter = (second.x - first.x - first.width) / 4;
  // The first tile's corner on the side the second one reaches past, a quarter gap out:
  // outside its rounded outline, inside the square one.
  const y = second.y <= first.y + 1 ? first.y - quarter : first.y + first.height + quarter;
  const corner = await page.screenshot({ clip: { x: first.x + first.width + quarter, y, width: 1, height: 1 } });
  expect(firstRowPixels(corner)).toEqual([[0, 0, 0]]);
});

test('two selected tiles that end a few pixels apart meet without a spike between them', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  // Two columns: the second tile ends a few pixels below the first, and the third tile, left
  // out, sits under the first.
  await serveFixtureSite(page, [fixturePost('1'), fixturePost('2', 495), fixturePost('3'), fixturePost('4')]);
  await page.goto('/app/explore');
  await tile(page, '1').click({ modifiers: ['Control'] });
  await tile(page, '2').click();
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.selection-layer [data-key]')]
    .flatMap((shape) => shape.getAnimations()).length)).toBe(0);
  const first = (await tile(page, '1').boundingBox())!;
  const second = (await tile(page, '2').boundingBox())!;
  expect(second.x).toBeGreaterThan(first.x + first.width);
  const step = second.y + second.height - (first.y + first.height);
  expect(step).toBeGreaterThan(1);
  expect(step).toBeLessThan(8);
  // Just inside the second tile's half of the gap, level with the end of the first tile.
  const middle = (first.x + first.width + second.x) / 2;
  const seam = await page.screenshot({ clip: { x: middle + 1, y: first.y + first.height - 1, width: 1, height: 1 } });
  const accent = (await page.evaluate(() => getComputedStyle(document.querySelector('.selection-layer')!).fill)).match(/\d+/g)!.map(Number);
  const [[r, g, b]] = firstRowPixels(seam);
  expect(Math.abs(r - accent[0]) + Math.abs(g - accent[1]) + Math.abs(b - accent[2])).toBeLessThan(12);
});

test('the colour wraps the corner of a tile left out between selected tiles beside and below it', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  // Two columns: the first tile, left out, ends 3px below the second; the third and fourth
  // stack under them, so the tile under the first starts 3px below the one beside it.
  await serveFixtureSite(page, [fixturePost('1'), fixturePost('2', 469), fixturePost('3'), fixturePost('4')]);
  await page.goto('/app/explore');
  await tile(page, '2').click({ modifiers: ['Control'] });
  await tile(page, '3').click();
  await tile(page, '4').click();
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.selection-layer [data-key]')]
    .flatMap((shape) => shape.getAnimations()).length)).toBe(0);
  const left = (await tile(page, '1').boundingBox())!;
  const beside = (await tile(page, '2').boundingBox())!;
  const below = (await tile(page, '4').boundingBox())!;
  expect(below.x).toBe(left.x);
  expect(beside.x).toBeGreaterThan(left.x + left.width);
  const half = (below.y - left.y - left.height) / 2;
  const middle = (left.x + left.width + beside.x) / 2;
  // Inside the square corner of the gap around the first tile, outside its rounded outline.
  const corner = await page.screenshot({ clip: { x: middle - 3, y: left.y + left.height + half - 3, width: 1, height: 1 } });
  const accent = (await page.evaluate(() => getComputedStyle(document.querySelector('.selection-layer')!).fill)).match(/\d+/g)!.map(Number);
  const [[r, g, b]] = firstRowPixels(corner);
  expect(Math.abs(r - accent[0]) + Math.abs(g - accent[1]) + Math.abs(b - accent[2])).toBeLessThan(12);
});

test('selected tiles flow together across the gap, in from and back to the selected tile beside them', async ({ page }) => {
  await serveFixtureSite(page);
  await page.goto('/app/explore');
  const flow = (id: string) => page.locator(`.selection-layer [data-key="fixture:${id}"]`).evaluate((shape) => {
    const animation = shape.getAnimations().at(-1);
    const frames = (animation?.effect as KeyframeEffect | undefined)?.getKeyframes() ?? [];
    const layer = shape.ownerSVGElement!.getBoundingClientRect();
    const tile = document.querySelector(`[data-select-key="${shape.getAttribute('data-key')}"]`)!.getBoundingClientRect();
    // Where the colour gathers, from the tile's own left edge.
    const fromLeft = parseFloat(getComputedStyle(shape).transformOrigin) - (tile.left - layer.left);
    return { from: frames[0]?.transform, to: frames.at(-1)?.transform, fromLeft };
  });
  await tile(page, '1').click({ modifiers: ['Control'] });
  await tile(page, '2').click();
  // The second tile's colour flows in from its left, where the first one is.
  const joining = await flow('2');
  expect(joining).toMatchObject({ from: 'scale(0, 1)', to: 'none' });
  expect(joining.fromLeft).toBeLessThan(0);
  await expect.poll(() => page.locator('.selection-layer [data-key]').first().evaluate((shape) =>
    shape.getAnimations().every((animation) => animation.playState === 'finished'))).toBe(true);
  // The gap between the two tiles is all colour: the picture is outside it.
  const first = (await tile(page, '1').boundingBox())!;
  const second = (await tile(page, '2').boundingBox())!;
  const gap = await page.screenshot({
    // Two pixels in from each tile: the tiles sit on fractional pixels and their edges blend.
    clip: { x: first.x + first.width + 2, y: first.y + first.height / 2, width: second.x - first.x - first.width - 4, height: 1 }
  });
  const accent = (await page.evaluate(() => getComputedStyle(document.querySelector('.selection-layer')!).fill)).match(/\d+/g)!.map(Number);
  const offColour = Math.max(...firstRowPixels(gap).map(([r, g, b]) => Math.abs(r - accent[0]) + Math.abs(g - accent[1]) + Math.abs(b - accent[2])));
  expect(offColour).toBeLessThan(12);
  // On its outer side the colour stops at half the gap, where the outline around a tile left
  // out stops too, so the two never step past each other.
  const halfGap = (second.x - first.x - first.width) / 2;
  const beyond = await page.screenshot({ clip: { x: first.x - halfGap - 3, y: first.y + first.height / 2, width: 2, height: 1 } });
  expect(firstRowPixels(beyond)).toEqual([[0, 0, 0], [0, 0, 0]]);
  // Deselected, the second tile's colour drains back towards the first instead of vanishing.
  await tile(page, '2').click();
  expect(await flow('2')).toMatchObject({ from: 'none', to: 'scale(0, 1)' });
  await expect(page.locator('.selection-layer [data-key="fixture:2"]')).toHaveCount(0);
});
