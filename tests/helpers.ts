/**
 * Shared Playwright helpers. Keeping these tiny on purpose — the goal is
 * one shape across specs, not a framework.
 */
import { expect, type Page } from '@playwright/test';

/**
 * A 64x120 PNG. Use this when the test depends on a thumbnail existing.
 *
 * Deliberately portrait: the detail view reserves space for the incoming file
 * using its aspect ratio, and a landscape fixture hides mistakes there —
 * a wrongly-shaped box happens to end up the same size for wide images.
 */
export const thumbnailablePng =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAB4CAIAAADNImNJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABDElEQVR4nO2SAQkAURSDlu7SLY4BL4Y8/mABVBa+nl50AiZQvSK7UO8uOgETqF6RXah3F52ACVSvyC7Uu4tOwASqV2QX6t1FJ2AC1SuyC/XuohMwgeoV2YV6d9EJmED1iuxCvbvoBEygekV2od5ddAImUL0iu1DvLjoBE6hekV2odxedgAlUr8gu1LuLTsAEqldkF+rdRSdgAtUrsgv17qITMIHqFdmFenfRCZhA9YrsQr276ARMoHpFdqHeXXQCJlC9IrtQ7y46AROoXpFdqHcXnYAJVK/ILtS7i07ABKpXZBfq3UUnYALVK7IL9e6iEzCB6hXZhXp30QmYQPWK7EK9u+gETKB6RV6+0A9kILakCkzd7wAAAABJRU5ErkJggg==';

export const uploadSampleImages = async (
  page: Page,
  fileNames: string[],
  options: { base64?: string } = {}
) => {
  let folderId = '';
  await expect.poll(async () => {
    const response = await page.request.get('/folders');
    expect(response.ok()).toBeTruthy();
    const data = await response.json() as { folders: Array<{ id: string }> };
    folderId = data.folders[0]?.id ?? '';
    return folderId;
  }).not.toBe('');
  const form = new FormData();
  for (const name of fileNames) {
    form.append('files', new File([Buffer.from(options.base64 ?? thumbnailablePng, 'base64')], name, { type: 'image/png' }));
  }
  const response = await page.request.post(`/folders/${folderId}/uploads`, { multipart: form });
  expect(response.ok()).toBeTruthy();
  const result = await response.json() as { uploaded: unknown[]; rejected: unknown[] };
  expect(result.rejected).toEqual([]);
  expect(result.uploaded).toHaveLength(fileNames.length);
};
