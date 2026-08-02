import { expect, test } from '@playwright/test';

import { loginWithUi, registerWithUi } from './helpers';

test('register → login → me → logout round-trips via the SPA + API', async ({
  page
}) => {
  const user = {
    username: `pw_${Date.now()}`,
    password: 'Password123'
  };

  await registerWithUi(page, user);
  await page.goto('/app/settings');
  await expect(page.getByText(`Signed in as ${user.username}`)).toBeVisible();

  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  await loginWithUi(page, user);
  await page.goto('/app/settings');
  await expect(page.getByText(`Signed in as ${user.username}`)).toBeVisible();

  const me = await page.request.get('/auth/me');
  expect(me.ok(), `/auth/me: ${me.status()}`).toBeTruthy();
  const body = (await me.json()) as { user: { username: string } };
  expect(body.user.username).toBe(user.username);

  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page).toHaveURL(/\/login/);
});

test('protected /folders endpoint refuses an unauthenticated SPA fetch', async ({
  page
}) => {
  await page.context().clearCookies();
  const res = await page.request.get('/folders', { failOnStatusCode: false });
  expect(res.status()).toBe(401);
});

test('unauthenticated app routes redirect to /login', async ({ page }) => {
  await page.context().clearCookies();
  for (const route of [
    '/app/gallery',
    '/app/settings',
    '/app/settings/duplicates'
  ]) {
    await page.goto(route);
    await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  }
});
