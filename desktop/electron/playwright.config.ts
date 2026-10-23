import { defineConfig } from '@playwright/test';

// Runs the desktop window against the debug core: `cargo build -p gooncave-desktop` first.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  workers: 1
});
