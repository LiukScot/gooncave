import '../test/helpers/setupEnv';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runAutoFavoritesSyncForEnabledUsers } from './worker';

test('midnight favorites sync still starts for enabled users when another user errors', async () => {
  const started: string[] = [];
  const warnings: string[] = [];

  await runAutoFavoritesSyncForEnabledUsers({
    listUsers: async () => [
      { id: 'broken-user' },
      { id: 'disabled-user' },
      { id: 'enabled-user' }
    ],
    getFavoritesSettings: async (userId) => {
      if (userId === 'broken-user') throw new Error('settings failed');
      return {
        reverseSyncEnabled: false,
        autoSyncMidnight: userId === 'enabled-user',
        autoFavEnabled: false,
        favoritesRootId: null
      };
    },
    startFavoritesSync: (userId) => {
      started.push(userId);
      return { status: 'started' };
    },
    warn: (message) => warnings.push(message)
  });

  assert.deepEqual(started, ['enabled-user']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /broken-user/);
});

test('midnight favorites sync logs and returns when user listing fails', async () => {
  const warnings: string[] = [];

  await runAutoFavoritesSyncForEnabledUsers({
    listUsers: async () => {
      throw new Error('db unavailable');
    },
    getFavoritesSettings: async () => {
      throw new Error('should not run');
    },
    startFavoritesSync: () => {
      throw new Error('should not run');
    },
    warn: (message) => warnings.push(message)
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /list users/);
});
