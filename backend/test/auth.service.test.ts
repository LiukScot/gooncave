// setupEnv MUST be first — auth service pulls in config + dataStore.
import './helpers/setupEnv';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'path';

import { hashPassword, isPathInside, verifyPassword } from '../src/services/auth';

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
