import { expectBarBesideCornerButton, selectionPosts as posts, serveFixtureSite, tile } from './gridSelectionFixtures';
import { expect, test } from './helpers';


test('Ctrl-click selects on desktop and Escape leaves', async ({ page }) => {
  await serveFixtureSite(page);
  await page.goto('/app/explore');
  await tile(page, '1').click({ modifiers: ['Control'] });
  const bar = page.getByRole('toolbar', { name: 'Selection' });
  await expect(bar).toContainText('1 selected');
  await expect(bar.getByRole('button')).toHaveText(['Favorite', 'Vote up', 'Vote down', 'Select all', 'Cancel']);
  expect(await expectBarBesideCornerButton(page)).toEqual({
    centredOnButton: true, leftOfButton: true, inTheLeftHalf: true, besideTheMenu: true
  });
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
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

test('a History search that hides every selected post ends the selection', async ({ page }) => {
  await serveFixtureSite(page);
  await page.route('**/read-marks/history?*', (route) => {
    const tags = new URL(route.request().url()).searchParams.get('tags');
    return route.fulfill({ json: { posts: tags ? [] : posts, nextCursor: null } });
  });
  await page.goto('/app/explore?feed=history');
  await tile(page, '1').click({ modifiers: ['Control'] });
  const bar = page.getByRole('toolbar', { name: 'Selection' });
  await expect(bar).toContainText('1 selected');
  await page.getByRole('button', { name: 'Search History' }).click();
  await page.locator('#history-tag-search').fill('fox');
  await expect(tile(page, '1')).toHaveCount(0);
  await expect(bar).toHaveCount(0);
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

test('selected tiles join across the gap, filling from and draining to the selected tile beside them', async ({ page }) => {
  await serveFixtureSite(page);
  await page.goto('/app/explore');
  const edge = (id: string) => page.locator(`.selection-slot:has([data-select-key="fixture:${id}"]) > .selection-edge`);
  const fill = (id: string) => edge(id).evaluate((element) => {
    const animation = element.getAnimations()[0];
    const frames = (animation?.effect as KeyframeEffect | undefined)?.getKeyframes() ?? [];
    return { from: frames[0]?.clipPath, to: frames.at(-1)?.clipPath, visibility: getComputedStyle(element).visibility };
  });
  await tile(page, '1').click({ modifiers: ['Control'] });
  await tile(page, '2').click();
  // The second tile fills from its left, where the first one is.
  expect(await fill('2')).toEqual({ from: 'inset(0px 100% 0px 0px)', to: 'inset(0px)', visibility: 'visible' });
  const shape = await page.evaluate(() => {
    const box = (id: string, part: string) =>
      document.querySelector(`.selection-slot:has([data-select-key="fixture:${id}"]) ${part}`)!.getBoundingClientRect();
    const firstEdge = document.querySelector('.selection-slot:has([data-select-key="fixture:1"]) > .selection-edge')!;
    return {
      overPicture: getComputedStyle(document.querySelector('[data-select-key="fixture:1"]')!, '::after').content,
      aroundFirst: box('1', '.selection-edge').left < box('1', '[data-select-key]').left,
      noGap: box('1', '.selection-edge').right >= box('2', '.selection-edge').left,
      innerCorners: [getComputedStyle(firstEdge).borderTopRightRadius, getComputedStyle(firstEdge).borderBottomRightRadius],
      outerCorner: getComputedStyle(firstEdge).borderTopLeftRadius
    };
  });
  // The colour lies outside the picture, and the two edges meet with square corners between them.
  expect(shape).toMatchObject({ overPicture: 'none', aroundFirst: true, noGap: true, innerCorners: ['0px', '0px'] });
  expect(shape.outerCorner).not.toBe('0px');
  // Deselected, the second tile's colour drains back towards the first instead of vanishing.
  await tile(page, '2').click();
  expect(await fill('2')).toEqual({ from: 'inset(0px)', to: 'inset(0px 100% 0px 0px)', visibility: 'visible' });
});
