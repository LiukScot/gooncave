import { expect, test } from '@playwright/test';

import { thumbnailablePng, uploadSampleImages } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const uniquePng = (name: string) =>
  Buffer.concat([Buffer.from(thumbnailablePng, 'base64'), Buffer.from(name)]).toString('base64');

test('a Gallery file known to have relatives holds their place before they arrive', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const [related, lone] = [`related-${stamp}.png`, `lone-${stamp}.png`];
  await page.goto('/app/gallery');
  await uploadSampleImages(page, [related], { base64: uniquePng(related) });
  await uploadSampleImages(page, [lone], { base64: uniquePng(lone) });

  await page.route(/\/files\?/, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { files: { path: string; hasRelations: boolean }[] };
    for (const file of body.files) file.hasRelations = file.path.endsWith(related);
    await route.fulfill({ response, json: body });
  });
  let answer = () => {};
  const held = new Promise<void>((resolve) => { answer = resolve; });
  await page.route(/\/files\/[^/]+\/relations/, async (route) => {
    await held;
    const post = {
      remoteId: '1', siteId: 'fixture', siteName: 'Fixture', engine: 'e621', previewUrl: '/favicon.png',
      sampleUrl: null, fileUrl: '/favicon.png', width: 10, height: 10, tags: [], parentId: null, hasChildren: true,
      poolIds: [], isParent: true, isCurrent: false, localFileId: null
    };
    await route.fulfill({ json: { posts: [post] } });
  });
  await page.reload();

  const tile = (name: string) =>
    page.locator('[data-test-id="file-card"]').and(page.locator(`[aria-label*="${name}"]`));
  await expect(tile(related).locator('[data-test-id="card-relations"]')).toBeVisible();
  await expect(tile(lone).locator('[data-test-id="card-relations"]')).toHaveCount(0);

  await tile(lone).click({ position: { x: 8, y: 8 } });
  await expect(page.locator('.file-detail-panel-current')).toBeVisible();
  await expect(page.locator('.file-detail-panel-current .file-detail-relation')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to gallery' }).click();

  await tile(related).click({ position: { x: 8, y: 8 } });
  const current = page.locator('.file-detail-panel-current');
  await expect(current.locator('.file-detail-relation.is-pending')).toHaveCount(2);
  const tags = current.locator('.file-detail-tags');
  const before = (await tags.boundingBox())!.y;

  answer();
  await expect(current.locator('button.file-detail-relation')).toHaveCount(1);
  expect((await tags.boundingBox())!.y).toBeCloseTo(before, 0);

  const { files } = (await (await page.request.get('/files?limit=500')).json()) as { files: { id: string; path: string }[] };
  for (const file of files) {
    if (file.path.endsWith(related) || file.path.endsWith(lone)) await page.request.delete(`/files/${file.id}`);
  }
});
