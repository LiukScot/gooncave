import { expect, test } from '@playwright/test';

import { e2eUser, loginUi } from './helpers';

test('register → login → me → logout round-trips via the SPA + API', async ({ page, request }) => {
  // `smoke` user is seeded by `webServer.command`; we register an
  // additional one here to exercise the full client flow.
  const username = `pw_${Date.now()}`;
  const reg = await request.post('/auth/register', {
    data: { username, password: 'Password123' }
  });
  expect(reg.ok(), `register: ${reg.status()}`).toBeTruthy();

  // Login via the UI with the pre-seeded smoke user.
  await loginUi(page);
  // After successful login the protected route shell shows the user header.
  await expect(page.getByText(`Signed in as ${e2eUser.username}`)).toBeVisible();

  // The cookie should now satisfy /auth/me.
  const me = await page.request.get('/auth/me');
  expect(me.ok(), `/auth/me: ${me.status()}`).toBeTruthy();
  const body = (await me.json()) as { user: { username: string } };
  expect(body.user.username).toBe(e2eUser.username);

  // Logout button is in the page header — click it and assert we are
  // back on the auth screen.
  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
});

test('protected /folders endpoint refuses an unauthenticated SPA fetch', async ({ page }) => {
  await page.context().clearCookies();
  const res = await page.request.get('/folders', { failOnStatusCode: false });
  expect(res.status()).toBe(401);
});

test('unauthenticated /app/gallery redirects to /login', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/app/gallery');
  await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
