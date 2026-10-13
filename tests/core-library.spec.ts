import { expect, test } from '@playwright/test';

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
    await page.goto('/app/settings');
    await expect(page.getByRole('link', { name: 'Folders', exact: true })).toHaveCount(0);
    await page.goto('/app/gallery');
    await card(page, uploaded).click();
    await expect(page).toHaveURL(/fileId=/);
    await page.getByRole('button', { name: 'File info' }).click();
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
    await page.locator('.file-detail-panel-current .file-detail-delete-button').click();
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
  // The file's name sits in File info, which opens folded.
  await page.getByRole('button', { name: 'File info' }).click();
  await expect(page.locator('.file-detail-panel-current').getByText('landscape.png')).toBeVisible();
});
