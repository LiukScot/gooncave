// setupEnv MUST be first — auth service pulls in config + DB wiring.
import './helpers/setupEnv';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'path';

import { authRepo } from '../src/db/repos/authRepo';
import { foldersRepo } from '../src/db/repos/foldersRepo';
import { hashPassword, isPathInside, registerLocalUser, verifyPassword } from '../src/services/auth';

test('hashPassword + verifyPassword round-trips', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.ok(hash.startsWith('$argon2id$'));
  assert.equal(await verifyPassword(hash, 'correct horse battery staple'), true);
  assert.equal(await verifyPassword(hash, 'wrong'), false);
});

test('isPathInside accepts subpaths', () => {
  const base = '/var/data';
  assert.equal(isPathInside('/var/data/users/alice/file.png', base), true);
  assert.equal(isPathInside(base, base), true);
});

test('isPathInside rejects sibling and traversal paths', () => {
  const base = '/var/data';
  assert.equal(isPathInside('/var/data2/file', base), false);
  assert.equal(isPathInside('/etc/passwd', base), false);
  // Traversal: candidate resolves outside base
  assert.equal(isPathInside(path.join(base, '..', 'other', 'file'), base), false);
});

test('registerLocalUser deletes the user row if root folder creation fails', async () => {
  const originalAddFolder = foldersRepo.addFolder;
  foldersRepo.addFolder = async () => {
    throw new Error('folder create failed');
  };

  try {
    await assert.rejects(
      registerLocalUser('rollback_case', 'longenoughpassword'),
      /folder create failed/
    );
  } finally {
    foldersRepo.addFolder = originalAddFolder;
  }

  const created = await authRepo.findUserByUsername('rollback_case');
  assert.equal(created, null);
});
