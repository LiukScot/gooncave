// Unit tests for pure auth utilities. No DB or network required.
import assert from 'node:assert/strict';

import { test } from 'bun:test';

import { isPathInside } from './auth';

test('isPathInside returns true for a file directly inside the base', () => {
  assert.equal(isPathInside('/srv/lib/user/a.jpg', '/srv/lib/user'), true);
});

test('isPathInside returns true for a nested path', () => {
  assert.equal(
    isPathInside('/srv/lib/user/sub/dir/a.jpg', '/srv/lib/user'),
    true
  );
});

test('isPathInside returns true when candidate equals base', () => {
  assert.equal(isPathInside('/srv/lib/user', '/srv/lib/user'), true);
});

test('isPathInside returns false for path traversal with ..', () => {
  assert.equal(
    isPathInside('/srv/lib/user/../etc/passwd', '/srv/lib/user'),
    false
  );
});

test('isPathInside returns false for a sibling directory', () => {
  assert.equal(isPathInside('/srv/lib/other', '/srv/lib/user'), false);
});

test('isPathInside returns false for a prefix-matching directory name', () => {
  // /srv/lib/user-evil should not pass as inside /srv/lib/user
  assert.equal(isPathInside('/srv/lib/user-evil/file.jpg', '/srv/lib/user'), false);
});
