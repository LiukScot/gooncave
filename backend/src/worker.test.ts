import '../test/helpers/setupEnv';

import assert from 'node:assert/strict';

import { test } from 'bun:test';

import {
  runAutoFavoritesSyncForEnabledUsers,
  shouldWarnMissingLocalFolder
} from './worker';

test('midnight favorites sync starts for enabled users', async () => {
  const started: string[] = [];
  const warnings: string[] = [];

  await runAutoFavoritesSyncForEnabledUsers({
    listUsersWithAutoSyncFavorites: async () => ['enabled-user'],
    startFavoritesSync: (userId) => {
      started.push(userId);
      return { status: 'started' };
    },
    warn: (message) => warnings.push(message)
  });

  assert.deepEqual(started, ['enabled-user']);
  assert.equal(warnings.length, 0);
});

test('midnight favorites sync logs and returns when user listing fails', async () => {
  const warnings: string[] = [];

  await runAutoFavoritesSyncForEnabledUsers({
    listUsersWithAutoSyncFavorites: async () => {
      throw new Error('db unavailable');
    },
    startFavoritesSync: () => {
      throw new Error('should not run');
    },
    warn: (message) => warnings.push(message)
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /list eligible users/);
});

test('shouldWarnMissingLocalFolder warns once until the folder exists again', () => {
  assert.equal(
    shouldWarnMissingLocalFolder('folder-a', '/missing/path', false),
    true
  );
  assert.equal(
    shouldWarnMissingLocalFolder('folder-a', '/missing/path', false),
    false
  );

  assert.equal(
    shouldWarnMissingLocalFolder('folder-a', '/missing/path', true),
    false
  );
  assert.equal(
    shouldWarnMissingLocalFolder('folder-a', '/missing/path', false),
    true
  );
});
