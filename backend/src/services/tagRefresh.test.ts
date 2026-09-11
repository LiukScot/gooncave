// Setup must run before the database client opens SQLite.
import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';

import { test } from 'bun:test';

import { seedUser } from '../../test/helpers/testApp';
import { booruSitesRepo } from '../db/repos/booruSitesRepo';

import { getTagRefreshProgress, startTagRefresh } from './tagRefresh';

test('an empty refresh releases the account job immediately', async () => {
  const seeded = await seedUser({ username: 'empty_tag_refresh' });
  const site = await booruSitesRepo.insertBooruSite(
    {
      name: 'e621',
      engine: 'e621',
      baseUrl: 'https://e621.net',
      enabled: true
    },
    seeded.user.id
  );

  const first = await startTagRefresh(seeded.user.id, site.id);
  assert.equal(first.status, 'started');
  assert.equal(getTagRefreshProgress(seeded.user.id).status, 'done');

  const second = await startTagRefresh(seeded.user.id, site.id);
  assert.equal(second.status, 'started');
});
