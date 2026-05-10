import { expect, test } from '@playwright/test';

import { newUser } from '../fixtures/users';

/**
 * Regression for issue #67. When the backend returns 401 (e.g. session
 * expired), the SPA listens for `gooncave:auth-required` and snaps the user
 * back to the login screen. If that wiring breaks, the user gets stuck on
 * a half-rendered page making failing requests.
 *
 * We simulate the expiry by clearing the session cookie out of the browser,
 * then triggering any authenticated request from the SPA.
 */
test('client returns to login form after a forced 401', async ({ page, context }) => {
  const user = newUser();
  await page.goto('/');
  await page.getByRole('button', { name: 'Register' }).click();
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByLabel('Confirm password').fill(user.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();

  // Wipe just the session cookie. The SPA still thinks we're authed until
  // the next backend round-trip returns 401.
  await context.clearCookies({ name: 'gooncave_session' });

  // Reloading triggers `/auth/me`, which is now 401 → SPA dispatches the
  // auth-required event → login form re-renders.
  await page.reload();

  await expect(page.getByRole('button', { name: 'Login' }).first()).toBeVisible();
  await expect(page.getByLabel('Username')).toBeVisible();
});
