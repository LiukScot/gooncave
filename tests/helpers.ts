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
      throw new Error(`registerApi failed: status=${res.status()} body=${body}`);
    }
  }
};

export const loginApi = async (
  request: APIRequestContext,
  overrides: Partial<typeof e2eUser> = {}
) => {
  const payload = { ...e2eUser, ...overrides };
  const res = await request.post('/auth/login', { data: payload });
  expect(res.ok(), `login expected to succeed for ${payload.username}; status=${res.status()}`).toBeTruthy();
};

export const loginUi = async (page: Page) => {
  await page.context().clearCookies();
  await page.goto('/');
  // App.tsx labels aren't htmlFor-linked to the inputs (#TODO §15), so we
  // select by the autocomplete attribute that *is* set on the inputs.
  await page.locator('input[autocomplete="username"]').fill(e2eUser.username);
  await page.locator('input[autocomplete="current-password"]').fill(e2eUser.password);
  // Two "Login" buttons exist (the mode toggle + the form submit); the
  // submit one is the only one of type="submit".
  await page.locator('form button[type="submit"]').click();
};
