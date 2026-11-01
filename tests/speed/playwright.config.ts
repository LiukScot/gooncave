import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defineConfig } from '@playwright/test';

const port = Number(process.env.SPEED_PORT || 4174);
const root = path.resolve(__dirname, '..', '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gooncave-speed-'));
// /tmp is often memory, and this library is too large to leave there after every run.
process.on('exit', () => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
const library = path.join(directory, 'library');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const output = (name: string) => quote(path.join(library, name));
// More than one gallery page. Each frame of testsrc2 differs, so the pictures do not collapse into duplicate stacks.
const seedLibrary = [
  `mkdir -p ${quote(library)}`,
  `ffmpeg -v error -f lavfi -i testsrc2=size=640x480:rate=1 -frames:v 180 ${output('landscape-%03d.jpg')}`,
  `ffmpeg -v error -f lavfi -i testsrc2=size=480x640:rate=1 -frames:v 70 ${output('portrait-%03d.jpg')}`,
  `ffmpeg -v error -f lavfi -i testsrc=size=320x240:rate=10 -t 2 -c:v libvpx-vp9 -cpu-used 8 ${output('clip.mp4')}`
].join(' && ');

export default defineConfig({
  testDir: '.',
  testMatch: 'speed.spec.ts',
  outputDir: path.join(root, 'test-results'),
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 720 } } },
    {
      name: 'iphone',
      use: {
        hasTouch: true,
        isMobile: true,
        viewport: { width: 375, height: 812 },
        launchOptions: {
          args: ['--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2']
        }
      }
    }
  ],
  webServer: {
    command: `${seedLibrary} && npm --prefix frontend run build && cargo run --locked -p gooncave-core -- ${quote(path.join(directory, 'data'))} ${quote(library)} ${quote(path.join(root, 'frontend', 'dist'))} ${port}`,
    cwd: root,
    port,
    reuseExistingServer: false,
    timeout: 600_000
  }
});
