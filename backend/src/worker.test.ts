import '../test/helpers/setupEnv';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runAutoFavoritesSyncForEnabledUsers, shouldWarnMissingLocalFolder } from './worker';

test('midnight favorites sync starts for enabled users', async () => {
  const started: string[] = [];
  const warnings: string[] = [];

  await runAutoFavoritesSyncForEnabledUsers({
    listUsers: async () => [
      { id: 'disabled-user' },
      { id: 'enabled-user' }
    ],
    getFavoritesSettings: async (userId) => {
      return {
        reverseSyncEnabled: false,
        autoSyncMidnight: userId === 'enabled-user',
        autoFavEnabled: false,
        favoritesRootId: null
      };
    },
    getFavoritesSettingsBatch: async (userIds) => {
      const map = new Map();
      for (const userId of userIds) {
        map.set(userId, {
          reverseSyncEnabled: false,
          autoSyncMidnight: userId === 'enabled-user',
          autoFavEnabled: false,
          favoritesRootId: null
        });
      }
      return map;
    },
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
    listUsers: async () => {
      throw new Error('db unavailable');
    },
    getFavoritesSettings: async () => {
      throw new Error('should not run');
    },
    getFavoritesSettingsBatch: async () => {
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

test('midnight favorites sync logs and returns when batch settings fetch fails', async () => {
  const warnings: string[] = [];

  await runAutoFavoritesSyncForEnabledUsers({
    listUsers: async () => [
      { id: 'user1' },
      { id: 'user2' }
    ],
    getFavoritesSettings: async () => {
      throw new Error('should not run');
    },
    getFavoritesSettingsBatch: async () => {
      throw new Error('settings db error');
    },
    startFavoritesSync: () => {
      throw new Error('should not run');
    },
    warn: (message) => warnings.push(message)
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fetch settings/);
});

test('shouldWarnMissingLocalFolder warns once until the folder exists again', () => {
  assert.equal(shouldWarnMissingLocalFolder('folder-a', '/missing/path', false), true);
  assert.equal(shouldWarnMissingLocalFolder('folder-a', '/missing/path', false), false);

  assert.equal(shouldWarnMissingLocalFolder('folder-a', '/missing/path', true), false);
  assert.equal(shouldWarnMissingLocalFolder('folder-a', '/missing/path', false), true);
});
