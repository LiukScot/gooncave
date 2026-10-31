import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig } from '@playwright/test';

const smokePort = Number(process.env.SMOKE_PORT || 4173);
const smokeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gooncave-core-playwright-'));
const frontendDist = path.resolve(__dirname, 'frontend', 'dist');
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const smokeLibrary = path.join(smokeDirectory, 'library');
// The library starts with a picture and a video, as if the owner had copied them into the folder.
// VP9 because Playwright's Chromium has no MPEG-4 or H.264 decoder: the viewer would drop the video.
const seedLibrary = [
  `mkdir -p ${quote(smokeLibrary)}`,
  `ffmpeg -v error -f lavfi -i testsrc=size=320x200 -frames:v 1 ${quote(path.join(smokeLibrary, 'landscape.png'))}`,
  `ffmpeg -v error -f lavfi -i testsrc=size=320x240:rate=10 -t 2 -c:v libvpx-vp9 -cpu-used 8 ${quote(path.join(smokeLibrary, 'clip.mp4'))}`
].join(' && ');

export default defineConfig({
  testDir: './tests',
  testMatch: ['core-foundations.spec.ts', 'core-library.spec.ts', 'gallery-scroll-restore.spec.ts', 'touch-overlay.spec.ts', 'button-groups.spec.ts', 'edge-swipe-back.spec.ts', 'detail-controls.spec.ts', 'toast-position.spec.ts'],
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: externalBaseURL || `http://127.0.0.1:${smokePort}`, headless: true, trace: 'retain-on-failure' },
  webServer: externalBaseURL ? undefined : {
    command: `${seedLibrary} && npm --prefix frontend run build && cargo run --locked -p gooncave-core -- ${quote(path.join(smokeDirectory, 'data'))} ${quote(smokeLibrary)} ${quote(frontendDist)} ${smokePort}`,
    port: smokePort,
    reuseExistingServer: false,
    timeout: 180_000
  }
});
