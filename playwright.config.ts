import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig } from '@playwright/test';

// Each Playwright run gets its own tmp SQLite file so reruns never
// inherit half-finished state from the previous run. The directory is
// cleaned up by the OS; we deliberately don't unlink it so a failing
// run leaves the DB on disk for inspection.
const smokePort = Number(process.env.SMOKE_PORT || 4173);
const smokeDbDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'gooncave-playwright-')
);
const smokeDbPath = path.join(smokeDbDir, 'smoke.sqlite');
const smokeLibrary = path.join(smokeDbDir, 'library');
fs.mkdirSync(smokeLibrary, { recursive: true });
const frontendDist = path.resolve(__dirname, 'frontend', 'dist');
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const quote = (value: string) => JSON.stringify(value);

const env = [
  `DATA_FILE=${quote(smokeDbPath)}`,
  `MEDIA_PATH=${quote(smokeLibrary)}`,
  `THUMBNAILS_DIR=${quote(path.join(smokeDbDir, 'thumbnails'))}`,
  `FRONTEND_DIR=${quote(frontendDist)}`,
  `ALLOWED_ORIGINS=http://127.0.0.1:${smokePort},http://localhost:${smokePort}`,
  `PORT=${smokePort}`,
  'HOST=127.0.0.1',
  // Disable background sync — tests are about UX, not crawlers.
  'FAVORITES_SYNC_INTERVAL_HOURS=0',
  'LOCAL_RESCAN_INTERVAL_MINUTES=0'
].join(' ');

const command = [
  `bun --cwd frontend run build &&`,
  `cd backend &&`,
  `rm -f ${quote(smokeDbPath)} ${quote(`${smokeDbPath}-shm`)} ${quote(`${smokeDbPath}-wal`)} &&`,
  `${env} bun x tsx src/migrate.ts &&`,
  `${env} bun x tsx src/smoke-seed.ts &&`,
  `${env} bun x tsx src/index.ts`
].join(' ');

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: externalBaseURL || `http://127.0.0.1:${smokePort}`,
    headless: true
  },
  webServer: externalBaseURL
    ? undefined
    : {
        command,
        port: smokePort,
        reuseExistingServer: false,
        timeout: 180_000
      }
});
