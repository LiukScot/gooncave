import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const CORE = path.resolve(__dirname, '..', '..', 'target', 'debug', 'gooncave-desktop');
// Outside Electron, `require('electron')` returns the binary's path and downloads it on first use.
const ELECTRON_BINARY: unknown = createRequire(__filename)('electron');
if (typeof ELECTRON_BINARY !== 'string') throw new Error('The electron package did not return the path of its binary.');

let home: string;
let app: ElectronApplication;
// Kept at launch: once the app has exited, `app.process()` can throw.
let child: ChildProcess;
// What the app and its core printed, attached to a failed test: a window that closes early says why there.
let output: string[];

const launch = async (core: string) => {
  app = await electron.launch({
    executablePath: ELECTRON_BINARY,
    args: [__dirname],
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_DATA_HOME: path.join(home, 'data'),
      GOONCAVE_CORE: core
    }
  });
  child = app.process();
  output = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.once('exit', (code, signal) => output.push(`[app exited with ${code ?? signal}]`));
};

/** Closes the window and resolves with the app's exit code, or `running` after 15 seconds. */
const closeWindow = async () => {
  const page = await app.firstWindow();
  await expect(page).toHaveTitle(/GoonCave/);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await page.close();
  return Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('running'), 15_000))]);
};

test.beforeEach(() => {
  // A throwaway home, so the run never touches the real library, settings or Pictures folder.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gooncave-window-'));
});

test.afterEach(async () => {
  const testInfo = test.info();
  if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach('app output', { body: output.join('') });
  // A test that passed has ended the app already.
  if (child && child.exitCode === null && child.signalCode === null) await app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('closing the window ends the app while a hidden browser window is open', async () => {
  await launch(CORE);
  // Stands in for the hidden browser that loads FurAffinity and Rule34 pages.
  await app.evaluate(({ BaseWindow }) => {
    new BaseWindow({ show: false });
  });
  expect(await closeWindow()).toBe(0);
});

test('a core that stops badly while closing shows no error once the window is gone', async () => {
  const core = path.join(home, 'core.sh');
  fs.writeFileSync(
    core,
    `#!/bin/sh\necho '{"ready":"data:text/html,<title>GoonCave</title>","scripts":{}}'\nread line\nexit 1\n`,
    { mode: 0o755 }
  );
  await launch(core);
  // A real error box would wait for a click; recording it lets the app go on.
  await app.evaluate(({ dialog }) => {
    dialog.showErrorBox = (title) => console.error(`error box: ${title}`);
  });
  expect(await closeWindow()).toBe(0);
});

test('an open-folder link shows the folder in the file manager and the page stays', async () => {
  await launch(CORE);
  const page = await app.firstWindow();
  await expect(page).toHaveTitle(/GoonCave/);
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { opened?: string[] }).opened = opened;
    shell.openPath = async (folder) => {
      opened.push(folder);
      return '';
    };
  });
  const folder = path.join(home, 'My Library#1');
  fs.mkdirSync(folder);
  await page.evaluate((target) => {
    const link = document.createElement('a');
    link.href = `/open-folder?path=${encodeURIComponent(target)}`;
    document.body.append(link);
    link.click();
  }, folder);
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened)).toEqual([folder]);
  expect(page.url()).not.toContain('/open-folder');
});

test('the window has no system title bar and its heading moves the window', async () => {
  await launch(CORE);
  const page = await app.firstWindow();
  const heading = page.locator('.page-header');
  await expect(heading).toBeVisible();
  const style = await heading.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      region: computed.getPropertyValue('-webkit-app-region'),
      select: computed.userSelect,
      reserved: parseFloat(computed.paddingRight),
      button: getComputedStyle(element.querySelector('button')!).getPropertyValue('-webkit-app-region')
    };
  });
  expect(style.region).toBe('drag');
  // Dragging the heading moves the window instead of selecting its text.
  expect(style.select).toBe('none');
  expect(style.button).toBe('no-drag');
  // Room for the window buttons the system draws over the heading's right end.
  expect(style.reserved).toBeGreaterThan(0);
  // A menu entry does not come off as a web link when dragged.
  const link = page.locator('.app-menu-link').first();
  expect(
    await link.evaluate((element) => !element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })))
  ).toBe(true);
  expect(await link.evaluate((element) => getComputedStyle(element.closest('.app-menu-body')!).userSelect)).toBe('none');
});

test('the window behind the page has the page colour, not white', async () => {
  await launch(CORE);
  const page = await app.firstWindow();
  await expect(page.locator('.page-header')).toBeVisible();
  // Where the page has not painted yet (a fast scroll, going back) the window itself shows.
  const pageColor = await page.evaluate(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g)!.map(Number);
    return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  });
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toUpperCase()))
    .toBe(pageColor);
});

test("a pool's heading leaves room for the window buttons and moves the window", async () => {
  await launch(CORE);
  const page = await app.firstWindow();
  await expect(page.locator('.page-header')).toBeVisible();
  await page.goto(new URL('/app/pool?site=e621&pool=1', page.url()).href);
  const heading = page.locator('.pool-head');
  await expect(heading).toBeVisible();
  const style = await heading.evaluate((element) => {
    const area = navigator.windowControlsOverlay.getTitlebarAreaRect();
    return {
      region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
      barEnd: element.querySelector('.pool-head-bar')!.getBoundingClientRect().right,
      areaEnd: area.x + area.width,
      width: window.innerWidth,
      back: getComputedStyle(element.querySelector('button, a')!).getPropertyValue('-webkit-app-region'),
      // Chromium resolves drag regions in document order: a later one takes the clicks of a button it overlaps.
      covered: [...element.querySelectorAll('.pool-head-bar :is(a, button)')].flatMap((control) => {
        const box = control.getBoundingClientRect();
        return [...document.querySelectorAll('*')]
          .filter((other) => control.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING && !control.contains(other))
          .filter((other) => getComputedStyle(other).getPropertyValue('-webkit-app-region') === 'drag')
          .filter((other) => {
            const r = other.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
          })
          .map((other) => `${control.textContent} under ${other.className}`);
      })
    };
  });
  expect(style.region).toBe('drag');
  // The pool's buttons sit in the top bar, left of the window buttons the system draws.
  expect(style.areaEnd).toBeLessThan(style.width);
  expect(style.barEnd).toBeLessThanOrEqual(style.areaEnd);
  expect(style.back).toBe('no-drag');
  expect(style.covered).toEqual([]);
});

test('an open file leaves room for the window buttons above it, and the window shows no scrollbar', async () => {
  const library = path.join(home, 'data', 'app.gooncave.desktop', 'library');
  fs.mkdirSync(library, { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'public', 'apple-touch-icon.png'), path.join(library, 'picture.png'));
  await launch(CORE);
  const page = await app.firstWindow();
  await page.locator('[data-test-id="file-card"]').first().click();
  const frame = page.locator('.file-detail-frame');
  await expect(frame).toBeVisible();
  const style = await frame.evaluate((element) => ({
    band: parseFloat(getComputedStyle(element).paddingTop),
    region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
    picture: getComputedStyle(element.firstElementChild!).getPropertyValue('-webkit-app-region'),
    scrollbar: getComputedStyle(document.documentElement).scrollbarWidth
  }));
  // The band above the picture holds the window buttons and moves the window.
  expect(style.band).toBeGreaterThan(0);
  expect(style.region).toBe('drag');
  expect(style.picture).toBe('no-drag');
  expect(style.scrollbar).toBe('none');
});
