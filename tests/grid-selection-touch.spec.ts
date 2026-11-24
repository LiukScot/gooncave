import { expectBarBesideCornerButton, serveFixtureSite, tile } from './gridSelectionFixtures';
import { expect, test, type Page } from './helpers';


const PHONE = {
  hasTouch: true,
  isMobile: true,
  viewport: { width: 375, height: 812 },
  launchOptions: {
    args: ['--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2']
  }
};

test.use(PHONE);

async function longPress(page: Page, id: string) {
  const box = await tile(page, id).boundingBox();
  if (!box) throw new Error(`Tile ${id} is not on screen`);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const input = await page.context().newCDPSession(page);
  try {
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.waitForTimeout(800);
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await input.detach();
  }
}

test('a long press selects a tile instead of opening it, and taps add more', async ({ page }) => {
  await serveFixtureSite(page);
  await page.goto('/app/explore');
  await expect(tile(page, '1')).toBeVisible();

  await longPress(page, '1');
  const bar = page.getByRole('toolbar', { name: 'Selection' });
  await expect(bar).toContainText('1 selected');
  await expect(page.locator('.file-detail-panel-current')).toHaveCount(0);
  expect(await expectBarBesideCornerButton(page)).toEqual({
    centredOnButton: true, leftOfButton: true, inTheLeftHalf: true, besideTheMenu: true
  });

  await tile(page, '2').tap();
  await expect(bar).toContainText('2 selected');
  await expect(page.locator('.file-detail-panel-current')).toHaveCount(0);

  await bar.getByRole('button', { name: 'Cancel' }).tap();
  await expect(bar).toHaveCount(0);
  await tile(page, '1').tap();
  await expect(page.locator('.file-detail-panel-current')).toBeVisible();
});

test('on a phone the actions open from a menu above the bar, and nothing in the bar reaches the corner button', async ({ page }) => {
  await serveFixtureSite(page);
  await page.goto('/app/explore');
  await longPress(page, '1');
  const bar = page.getByRole('toolbar', { name: 'Selection' });
  await expect(bar.getByRole('button')).toHaveText(['', '']);
  await expect(bar.getByRole('button', { name: 'Actions' })).toBeVisible();
  const lens = (await page.locator('.search-lens').boundingBox())!;
  for (const button of await bar.getByRole('button').all()) {
    const box = (await button.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(lens.x);
  }
  await bar.getByRole('button', { name: 'Actions' }).tap();
  const menu = page.getByRole('dialog', { name: 'Actions for the selection' });
  await expect(menu.getByRole('button')).toHaveText(['Favorite', 'Vote up', 'Vote down', 'Select all']);
  await menu.getByRole('button', { name: 'Select all' }).tap();
  await expect(bar).toContainText('2 selected');
  await expect(menu).toHaveCount(0);
});
