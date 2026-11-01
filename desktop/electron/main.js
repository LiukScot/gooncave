// The desktop window. It starts the core process (desktop/shell), which serves the app on a
// loopback port and asks this process to fetch pages behind Cloudflare's browser check; see
// desktop/shell/src/main.rs for the messages they exchange.
const { app, BaseWindow, BrowserWindow, Menu, clipboard, dialog, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { Engine, CLOSED, UNREACHABLE } = require('./browser');
const { isAppUri, openFolderPath } = require('./links');

const ICON = path.join(__dirname, '..', 'icons', 'app-icon-512.png');
// The Flatpak sets GOONCAVE_CORE; a development run uses the debug build.
const CORE = process.env.GOONCAVE_CORE ?? path.join(__dirname, '..', '..', 'target', 'debug', 'gooncave-desktop');

let core = null;
let origin = null;
let engine = null;
let window = null;
let closing = false;
let reopen = false;
let failure = null;

const send = (message) => {
  if (core?.stdin.writable) core.stdin.write(`${JSON.stringify(message)}\n`);
};

// Settings → Report issue shows the core's log, so this process's errors go there too.
const printError = console.error;
console.error = (...parts) => {
  printError(...parts);
  send({ log: parts.join(' ') });
};

const failAndQuit = (title, detail) => {
  dialog.showErrorBox(title, detail);
  app.exit(1);
};

const openOutside = (url) => {
  // A page cannot open file:// links, so it asks for a folder with an app link.
  // Only folders: a file could start a program.
  const folder = openFolderPath(url, origin);
  if (folder !== null) {
    fs.stat(folder, (error, stats) => {
      if (error || !stats.isDirectory()) return console.error(`Cannot open ${folder}: not a folder`);
      shell.openPath(folder).then((problem) => {
        if (problem) console.error(`Cannot open ${folder} in the file manager: ${problem}`);
      });
    });
    return;
  }
  if (url.startsWith('https://') || url.startsWith('http://')) {
    shell.openExternal(url).catch((error) => console.error(`Cannot open ${url} in the browser: ${error}`));
  }
};

const editMenu = (contents, params) => {
  const items = [];
  if (params.isEditable) {
    items.push(
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll' }
    );
  } else if (params.selectionText) {
    items.push({ role: 'copy' });
  }
  if (params.linkURL && !isAppUri(params.linkURL, origin)) {
    items.push({ label: 'Copy link', click: () => clipboard.writeText(params.linkURL) });
  }
  if (params.mediaType === 'image' && params.srcURL) {
    items.push({ label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) });
  }
  if (items.length > 0) Menu.buildFromTemplate(items).popup();
};

// Ends the app when its window closes, even while the hidden browser still has a window. The
// slow part, the last sync upload, runs in the core before it exits.
const quit = () => {
  if (!core) return app.quit();
  closing = true;
  engine?.drop();
  for (const other of BaseWindow.getAllWindows()) other.destroy();
  send({ close: true });
};

const openWindow = () => {
  window = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'GoonCave',
    icon: ICON,
    webPreferences: { spellcheck: false }
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => {
    if (isAppUri(event.url, origin)) return;
    event.preventDefault();
    openOutside(event.url);
  });
  contents.on('context-menu', (_event, params) => editMenu(contents, params));
  window.on('closed', () => {
    window = null;
    quit();
  });
  window.loadURL(origin).catch((error) => console.error(`Cannot load the app: ${error}`));
};

const answer = (id, work) =>
  work.then(
    (ok) => send({ id, ok }),
    (error) => {
      const code = error?.message === CLOSED ? CLOSED : UNREACHABLE;
      if (code === UNREACHABLE && error?.message !== UNREACHABLE) console.error(`GoonCave's browser failed: ${error}`);
      send({ id, error: code });
    }
  );

const receive = (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.error(`Unexpected line from the core: ${line}`);
    return;
  }
  if (typeof message.ready === 'string') {
    origin = message.ready;
    engine = new Engine(message.scripts, () => window);
    openWindow();
  } else if (message.failed) {
    failure = message.failed;
  } else if (Number.isInteger(message.id) && message.fetch && engine) {
    answer(message.id, engine.fetch(message.fetch));
  } else if (Number.isInteger(message.id) && message.file && engine) {
    answer(message.id, engine.file(message.file));
  } else if (Number.isInteger(message.id) && message.signIn && engine) {
    answer(message.id, engine.signIn(message.signIn));
  } else {
    console.error(`Unexpected message from the core: ${line}`);
  }
};

const startCore = () => {
  const args = [];
  try {
    args.push('--pictures', app.getPath('pictures'));
  } catch (error) {
    console.error(`No Pictures folder to move an earlier library from: ${error}`);
  }
  core = spawn(CORE, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  readline.createInterface({ input: core.stdout }).on('line', receive);
  core.on('error', (error) => {
    console.error(`Cannot start the core at ${CORE}: ${error}`);
    failAndQuit('Library unavailable', 'GoonCave could not start its library. Reinstall GoonCave, then open it again. Your saved data has not been deleted.');
  });
  // Without a listener, a write after the core ended would crash the window process.
  core.stdin.on('error', (error) => console.error(`Cannot reach the core: ${error}`));
  core.on('exit', (code, signal) => {
    core = null;
    // The window is gone already: a core that stopped badly while closing says why on stderr.
    if (closing) {
      if (code !== 0) console.error(`The core ended with ${code ?? signal} while closing.`);
      if (reopen) app.relaunch();
      app.quit();
      return;
    }
    const { title, detail } = failure ?? {
      title: 'GoonCave stopped',
      detail: 'The local library stopped working. Open GoonCave again. Your saved data has not been deleted.'
    };
    failAndQuit(title, detail);
  });
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Without this menu, the window keeps the page's whole height and no Alt menu bar.
  Menu.setApplicationMenu(null);
  app.on('second-instance', () => {
    // While closing, the core finishes the last sync upload; the app opens again after it.
    if (closing) {
      reopen = true;
      return;
    }
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  // Closing the app window decides when to quit (see `quit`), so the hidden browser's
  // window does not keep the app running.
  app.on('window-all-closed', () => {});
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, permission, allow) =>
      allow(permission === 'fullscreen' || permission === 'clipboard-sanitized-write')
    );
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    });
    startCore();
  });
}
