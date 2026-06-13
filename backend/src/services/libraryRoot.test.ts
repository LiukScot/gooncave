import assert from 'node:assert/strict';
import path from 'node:path';

import { test } from 'bun:test';

import { chooseLibraryRoot, resolveStoredRoot } from './libraryRoot';

test('resolveStoredRoot treats empty / whitespace as unset', () => {
  // Regression: path.resolve('') === process.cwd(), which would make uploads
  // land next to the backend instead of in the user's library.
  assert.equal(resolveStoredRoot(''), null);
  assert.equal(resolveStoredRoot('   '), null);
});

test('resolveStoredRoot resolves a real path', () => {
  assert.equal(resolveStoredRoot('/srv/library'), path.resolve('/srv/library'));
});

test('chooseLibraryRoot uses the preferred root when stored is unset', () => {
  assert.equal(
    chooseLibraryRoot({
      storedRoot: null,
      preferredRoot: '/media/users/alice',
      storedExists: false,
      storedHasEntries: false,
      preferredExists: false
    }),
    '/media/users/alice'
  );
});

test('chooseLibraryRoot keeps an existing populated stored root', () => {
  assert.equal(
    chooseLibraryRoot({
      storedRoot: '/custom/lib',
      preferredRoot: '/media/users/alice',
      storedExists: true,
      storedHasEntries: true,
      preferredExists: false
    }),
    '/custom/lib'
  );
});

test('chooseLibraryRoot migrates an empty stored root to the preferred one', () => {
  assert.equal(
    chooseLibraryRoot({
      storedRoot: '/custom/lib',
      preferredRoot: '/media/users/alice',
      storedExists: true,
      storedHasEntries: false,
      preferredExists: true
    }),
    '/media/users/alice'
  );
});

test('chooseLibraryRoot keeps the stored root when it equals the preferred one', () => {
  assert.equal(
    chooseLibraryRoot({
      storedRoot: '/media/users/alice',
      preferredRoot: '/media/users/alice',
      storedExists: true,
      storedHasEntries: true,
      preferredExists: true
    }),
    '/media/users/alice'
  );
});

test('chooseLibraryRoot falls back to preferred when neither root exists yet', () => {
  assert.equal(
    chooseLibraryRoot({
      storedRoot: '/custom/lib',
      preferredRoot: '/media/users/alice',
      storedExists: false,
      storedHasEntries: false,
      preferredExists: false
    }),
    '/media/users/alice'
  );
});
