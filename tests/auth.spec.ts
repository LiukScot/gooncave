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
    '/app/settings/folders',
    '/app/settings/file-sources',
    '/app/settings/duplicates',
    '/app/settings/accounts'
  ]) {
    await page.goto(route);
    await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  }
});

test('an expired session sends the open app to login and back', async ({
  page
}) => {
  const user = {
    username: `pw_expire_${Date.now()}`,
    password: 'Password123'
  };

  await registerWithUi(page, user);
  await expect(page.getByText(/^\d+ items?$/)).toBeVisible();

  // Answer gallery requests as the server does once a session expires.
  const files = (url: URL) => url.pathname === '/files';
  await page.route(files, (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Authentication required' })
    })
  );
  // Click in the page: a gallery refetch may hit the 401 first and replace
  // the button, which would leave a Playwright click waiting for it.
  await page.evaluate(() => {
    const random = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Random'
    );
    random?.click();
  });

  await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
  await expect(page).toHaveURL(/\/login\?redirect=%2Fapp%2Fgallery/);
  await page.unroute(files);

  await page.locator('input[autocomplete="username"]').fill(user.username);
  await page
    .locator('input[autocomplete="current-password"]')
    .fill(user.password);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/app\/gallery$/);
});
