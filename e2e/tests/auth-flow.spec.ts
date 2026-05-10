import { expect, test } from '@playwright/test';

import { newUser } from '../fixtures/users';

test('register → logged-in UI → logout → login form again', async ({ page }) => {
  const user = newUser();
  await page.goto('/');

  // Switch to register mode (Login is the default).
  await page.getByRole('button', { name: 'Register' }).click();
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByLabel('Confirm password').fill(user.password);
  await page.getByRole('button', { name: 'Create account' }).click();

  // Logged-in shell shows a Logout button. Use it as the success signal.
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();

  await page.getByRole('button', { name: 'Logout' }).click();

  // Back to login view: the auth form re-renders, so the button reappears.
  await expect(page.getByRole('button', { name: 'Login' }).first()).toBeVisible();
});

test('GET /auth/me returns 401 after logout', async ({ page, request }) => {
  const user = newUser();
  await page.goto('/');
  await page.getByRole('button', { name: 'Register' }).click();
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByLabel('Confirm password').fill(user.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();

  // Sanity: while logged in, /auth/me is 200.
  const me = await request.get('/auth/me');
  expect(me.status()).toBe(200);

  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page.getByRole('button', { name: 'Login' }).first()).toBeVisible();

  // After logout the cookie is cleared; the same request context inherits the
  // browser's cookies, so this should now be 401.
  const meAfter = await request.get('/auth/me');
  expect(meAfter.status()).toBe(401);
});
