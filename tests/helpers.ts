/**
 * Shared Playwright helpers. Keeping these tiny on purpose — the goal is
 * one shape across specs, not a framework.
 */
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const e2eUser = {
  username: process.env.E2E_USERNAME ?? 'smoke',
  password: process.env.E2E_PASSWORD ?? 'Password123'
};

export const registerApi = async (
  request: APIRequestContext,
  overrides: Partial<typeof e2eUser> = {}
) => {
  const payload = { ...e2eUser, ...overrides };
  const res = await request.post('/auth/register', { data: payload });
  // We accept 200 (fresh DB) and 400 (already-exists from a previous seed)
  // so reruns don't blow up. The actual login happens via cookie below.
  if (!res.ok()) {
    const body = await res.text();
    if (!body.includes('already exists')) {
      throw new Error(
        `registerApi failed: status=${res.status()} body=${body}`
      );
    }
  }
};

export const loginApi = async (
  request: APIRequestContext,
  overrides: Partial<typeof e2eUser> = {}
) => {
  const payload = { ...e2eUser, ...overrides };
  const res = await request.post('/auth/login', { data: payload });
  expect(
    res.ok(),
    `login expected to succeed for ${payload.username}; status=${res.status()}`
  ).toBeTruthy();
};

export const loginUi = async (page: Page) => {
  await loginWithUi(page, e2eUser);
};

export const loginWithUi = async (
  page: Page,
  overrides: Partial<typeof e2eUser> = {}
) => {
  const payload = { ...e2eUser, ...overrides };
  await page.context().clearCookies();
  await page.goto('/');
  // App.tsx labels aren't htmlFor-linked to the inputs (tracked in #TODO — see
  // AGENTS.md §15 for the accessibility rule), so we select by the autocomplete
  // attribute that *is* set on the inputs.
  await page.locator('input[autocomplete="username"]').fill(payload.username);
  await page
    .locator('input[autocomplete="current-password"]')
    .fill(payload.password);
  // Two "Login" buttons exist (the mode toggle + the form submit); the
  // submit one is the only one of type="submit".
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/app\/gallery$/);
};

export const registerWithUi = async (
  page: Page,
  overrides: Partial<typeof e2eUser> = {}
) => {
  const payload = { ...e2eUser, ...overrides };
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Register' }).click();
  await page.locator('input[autocomplete="username"]').fill(payload.username);
  await page
    .locator('input[autocomplete="new-password"]')
    .first()
    .fill(payload.password);
  await page
    .locator('input[autocomplete="new-password"]')
    .nth(1)
    .fill(payload.password);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/app\/gallery$/);
};

export const uploadSampleImage = async (
  page: Page,
  options: { suffix?: string } = {}
) => {
  const uniquePart = `${options.suffix ?? 'sample'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fileName = `tiny-${uniquePart}.png`;
  const chooserPromise = page.waitForEvent('filechooser');
  await page.goto('/app/folders');
  await expect(page).toHaveURL(/\/app\/folders$/);
  await page.getByRole('button', { name: 'Upload files' }).first().click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: fileName,
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAukB9pX6lz4AAAAASUVORK5CYII=',
      'base64'
    )
  });
  await expect(page.getByText('Uploaded 1 file.')).toBeVisible();
  return fileName;
};

/**
 * A 1x1 PNG. Cheap, but too small for thumbnail generation to succeed, so
 * files uploaded with it come back with `thumbUrl: null`.
 */
const tinyPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAukB9pX6lz4AAAAASUVORK5CYII=';

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
  const chooserPromise = page.waitForEvent('filechooser');
  await page.goto('/app/folders');
  await expect(page).toHaveURL(/\/app\/folders$/);
  await page.getByRole('button', { name: 'Upload files' }).first().click();
  const chooser = await chooserPromise;
  await chooser.setFiles(
    fileNames.map((name) => ({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from(options.base64 ?? tinyPng, 'base64')
    }))
  );
  await expect(
    page.getByText(`Uploaded ${fileNames.length} file`)
  ).toBeVisible();
};
