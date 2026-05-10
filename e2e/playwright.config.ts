import { defineConfig, devices } from '@playwright/test';

/**
 * Configuration for gooncave end-to-end tests.
 *
 * The suite assumes a live stack at `BASE_URL` (default http://localhost:4100).
 * In CI we start it via `docker compose up -d --wait api`. Locally you can
 * either run the same docker command or `npm run dev` from the repo root.
 *
 * Hard 3-minute mandate per project policy. Single chromium browser keeps the
 * total runtime well below that for the current spec count.
 */
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:4100';

export default defineConfig({
  testDir: './tests',
  // Each spec creates its own user, so they're independent and parallel-safe.
  fullyParallel: true,
  // CI: bail early on flake to surface the failing test quickly. Local: 0.
  retries: process.env.CI ? 1 : 0,
  // Single worker keeps signal clean while the suite is small. Bump when
  // the suite grows past ~10 specs.
  workers: 1,
  // Hard ceiling per test (project mandate is 3 min for the WHOLE suite).
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    // The very bug we test against (cookie Secure on plain HTTP) requires
    // the browser to honor the `Secure` attribute as it would in production.
    // Playwright's default chromium does this.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
