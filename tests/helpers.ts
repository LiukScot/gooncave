/**
 * Shared Playwright helpers. Keeping these tiny on purpose — the goal is
 * one shape across specs, not a framework.
 */
import { execFileSync } from 'node:child_process';

import { test as base, expect, type Page } from '@playwright/test';

// Specs import Playwright from here, so every one gets the `test` below.
export { expect, type Locator, type Page } from '@playwright/test';

type ConsoleFixtures = {
  /** Lets the test cause, on purpose, a browser error whose report matches `pattern`. */
  allowConsoleError: (pattern: RegExp) => void;
};

const FAILED_REQUEST = /^Failed to load resource: the server responded with a status of (\d+)/;

/**
 * Playwright's `test`, failing any test after which the browser console holds
 * an error, an uncaught exception or a server error from the core. A glitch
 * often leaves only that trace: an animation skipped, a render that threw.
 */
export const test = base.extend<ConsoleFixtures>({
  allowConsoleError: [
    async ({ context, baseURL }, use) => {
      const errors: string[] = [];
      const allowed: RegExp[] = [];
      context.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        const url = message.location().url;
        // Chromium reports every failed request here too. Fixtures point at sites that do not
        // exist on purpose; only the core answering with a server error counts.
        if (text.startsWith('Failed to load resource')) {
          const status = Number(FAILED_REQUEST.exec(text)?.[1] ?? 0);
          if (status < 500 || !url.startsWith(baseURL ?? '')) return;
        }
        errors.push(`console.error at ${url}: ${text}`);
      });
      context.on('weberror', (error) => errors.push(`uncaught: ${error.error().message}`));
      await use((pattern) => { allowed.push(pattern); });
      const unexpected = errors.filter((error) => !allowed.some((pattern) => pattern.test(error)));
      expect(unexpected, 'errors in the browser console').toEqual([]);
    },
    { auto: true }
  ]
});

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

/** A six-second MP4 of `size` (width x height), made with ffmpeg. */
export const videoFixture = (size = '320x240') => execFileSync('ffmpeg', [
  '-v', 'error', '-f', 'lavfi', '-i', `color=c=slategray:s=${size}:r=10`,
  '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mp4',
  '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'
]);

/**
 * Waits until no view transition runs and every finite animation has ended, so the next gesture
 * starts on a still page. Endless animations, such as a loading spinner, are ignored.
 */
export const waitForAnimations = (page: Page) =>
  expect
    .poll(() => page.evaluate(() =>
      !document.documentElement.matches(':active-view-transition') &&
      document.getAnimations().every((animation) =>
        animation.playState !== 'running' || animation.effect?.getComputedTiming().endTime === Infinity)))
    .toBe(true);

/** Waits until the browser has drawn two more frames, so effects of the last input have run. */
export const waitForPaint = (page: Page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
