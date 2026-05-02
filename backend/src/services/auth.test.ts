import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const backendRoot = path.resolve(__dirname, '..', '..');
const authModulePath = require.resolve('./auth');
const configModulePath = require.resolve('../config');

const loadAuthModule = () => {
  delete require.cache[authModulePath];
  delete require.cache[configModulePath];
  return require('./auth') as typeof import('./auth');
};

test('resolveUserManagedPath rejects symlink escape when leaf does not exist', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gooncave-auth-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const outsideRoot = path.join(tempRoot, 'outside');
  const linkPath = path.join(libraryRoot, 'escape-link');

  await fs.mkdir(libraryRoot, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  await fs.symlink(outsideRoot, linkPath, 'dir');

  const { resolveUserManagedPath } = loadAuthModule();

  await assert.rejects(
    () => resolveUserManagedPath(libraryRoot, 'escape-link/new-folder'),
    /Folder path must stay inside your library root/
  );

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('setSessionCookie uses secure cookies in production', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  delete require.cache[authModulePath];
  delete require.cache[configModulePath];
  process.env.NODE_ENV = 'production';

  const { setSessionCookie } = loadAuthModule();
  const captured: Array<{ token: string; options: Record<string, unknown> }> = [];
  const reply = {
    setCookie(_name: string, token: string, options: Record<string, unknown>) {
      captured.push({ token, options });
    }
  };

  setSessionCookie(reply as never, 'session-token', '2030-01-01T00:00:00.000Z');

  assert.equal(captured[0]?.token, 'session-token');
  assert.equal(captured[0]?.options.secure, true);

  if (previousNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previousNodeEnv;
  }
});
