// setupEnv MUST be first — auth service pulls in config + DB wiring.
import './helpers/setupEnv';

import assert from 'node:assert/strict';
import path from 'path';

import { test } from 'bun:test';

import { authRepo } from '../src/db/repos/authRepo';
import { foldersRepo } from '../src/db/repos/foldersRepo';
import {
  hashPassword,
  isPathInside,
  registerLocalUser,
  verifyPassword
} from '../src/services/auth';

test('hashPassword + verifyPassword round-trips', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.ok(hash.startsWith('$argon2id$'));
  assert.equal(
    await verifyPassword(hash, 'correct horse battery staple'),
    true
  );
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
  assert.equal(
    isPathInside(path.join(base, '..', 'other', 'file'), base),
    false
  );
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

test('registerLocalUser refuses a username that differs only by case, even when the two registrations race', async () => {
  // Both calls pass the service-level lookup before either has inserted:
  // argon2 hashing is where they yield. Only the transaction in createUser
  // can tell the second one no.
  const outcomes = await Promise.allSettled([
    registerLocalUser('RaceUser', 'longenoughpassword'),
    registerLocalUser('raceuser', 'longenoughpassword')
  ]);
  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
  const rejected = outcomes.filter((o) => o.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(
    ((rejected[0] as PromiseRejectedResult).reason as Error).message,
    /already exists/
  );
  const stored = await authRepo.findUserByUsername('RACEUSER');
  assert.ok(stored);
});
