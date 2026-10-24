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
