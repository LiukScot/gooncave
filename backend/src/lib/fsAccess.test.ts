// Pin behavior of the writable-probe helper. No app, no DB — just the
// helper and a real tmpdir.
import '../../test/helpers/setupEnv';

import fs from 'fs';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

import { test } from 'bun:test';

import { DirectoryWriteAccessError, ensureDirectoryWritable } from './fsAccess';

const tmpRoot = process.env.GOONCAVE_TEST_TMP_ROOT ?? os.tmpdir();

test('ensureDirectoryWritable resolves silently for a freshly-created tmp dir', async () => {
  const dir = path.join(tmpRoot, `fsaccess-ok-${Date.now()}`);
  await fs.promises.mkdir(dir, { recursive: true });
  await ensureDirectoryWritable(dir, 'Probe');
});

test('ensureDirectoryWritable creates a missing dir before probing', async () => {
  const dir = path.join(tmpRoot, `fsaccess-create-${Date.now()}`);
  // Sanity: dir does not exist.
  assert.equal(fs.existsSync(dir), false);
  await ensureDirectoryWritable(dir, 'Probe');
  assert.equal(fs.existsSync(dir), true);
});

test('ensureDirectoryWritable leaves no probe file behind on success', async () => {
  const dir = path.join(tmpRoot, `fsaccess-clean-${Date.now()}`);
  await ensureDirectoryWritable(dir, 'Probe');
  const after = await fs.promises.readdir(dir);
  assert.equal(
    after.filter((name) => name.startsWith('.gooncave-write-test-')).length,
    0
  );
});

test(
  'ensureDirectoryWritable throws DirectoryWriteAccessError when dir is read-only',
  { skip: process.getuid?.() === 0 },
  async () => {
    const dir = path.join(tmpRoot, `fsaccess-ro-${Date.now()}`);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.chmod(dir, 0o555);
    try {
      await assert.rejects(
        () => ensureDirectoryWritable(dir, 'Uploading files'),
        (err: unknown) => {
          assert.ok(err instanceof DirectoryWriteAccessError);
          assert.match((err as Error).message, /not writable/i);
          // Operation name is surfaced in the error message — caller-friendly.
          assert.match((err as Error).message, /Uploading files/);
          return true;
        }
      );
    } finally {
      await fs.promises.chmod(dir, 0o755);
    }
  }
);

test(
  'DirectoryWriteAccessError surfaces a non-empty .code when chmod-blocked',
  { skip: process.getuid?.() === 0 },
  async () => {
    const dir = path.join(tmpRoot, `fsaccess-code-${Date.now()}`);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.chmod(dir, 0o555);
    try {
      await ensureDirectoryWritable(dir, 'Probe');
      assert.fail('expected DirectoryWriteAccessError');
    } catch (err) {
      assert.ok(err instanceof DirectoryWriteAccessError);
      // Linux chmod 555 → EACCES; the helper passes the syscall code through.
      assert.ok(typeof (err as DirectoryWriteAccessError).code === 'string');
    } finally {
      await fs.promises.chmod(dir, 0o755);
    }
  }
);
