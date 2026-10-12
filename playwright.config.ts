import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig } from '@playwright/test';

const smokePort = Number(process.env.SMOKE_PORT || 4173);
const smokeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gooncave-core-playwright-'));
const frontendDist = path.resolve(__dirname, 'frontend', 'dist');
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export default defineConfig({
  testDir: './tests',
  // The other specs are the server application's reference scenarios to port with its features.
  testMatch: 'core-foundations.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: externalBaseURL || `http://127.0.0.1:${smokePort}`, headless: true },
  webServer: externalBaseURL ? undefined : {
    command: `bun run --cwd frontend build && cargo run --locked -p gooncave-core -- ${quote(smokeDirectory)} ${quote(frontendDist)} ${smokePort}`,
    port: smokePort,
    reuseExistingServer: false,
    timeout: 180_000
  }
});
