import { expect, test } from '@playwright/test';

import { newUser } from '../fixtures/users';

/**
 * Regression guard for issue #67.
 *
 * Symptom: production set the session cookie with `Secure`, but the deployed
 * stack served plain HTTP, so the browser dropped the cookie and the user
 * was kicked back to the login screen on the very next request.
 *
 * The fix flipped the default of `AUTH_COOKIE_SECURE` to `false` for plain-
 * HTTP deployments. The unit test in backend/test/auth.routes.test.ts checks
 * the `Set-Cookie` header. This spec checks the actual *browser* behaviour:
 * if the cookie were Secure on http://, chromium would silently discard it
 * and the reload below would land on the login form again.
 */
test('login over plain HTTP survives a full page reload', async ({ page, context }) => {
  const user = newUser();
  await page.goto('/');
  await page.getByRole('button', { name: 'Register' }).click();
  await page.getByLabel('Username').fill(user.username);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByLabel('Confirm password').fill(user.password);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();

  // The bug shape: reload kicks the user out because the Secure cookie was
  // dropped by the browser on http://.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible();

  // Belt-and-braces: inspect the cookie directly.
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === 'gooncave_session');
  expect(session, 'session cookie must be set').toBeDefined();
  expect(session!.secure, 'Secure must be off when serving over http://').toBe(false);
  expect(session!.httpOnly).toBe(true);
  expect(session!.sameSite?.toLowerCase()).toBe('lax');
});
