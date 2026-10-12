import './helpers/setupEnv';

import assert from 'node:assert/strict';

import { afterAll, beforeAll, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';

import { booruSitesRepo } from '../src/db/repos/booruSitesRepo';
import { favoritesRepo } from '../src/db/repos/favoritesRepo';
import { filesRepo } from '../src/db/repos/filesRepo';
import { foldersRepo } from '../src/db/repos/foldersRepo';
import { remoteOrigins } from '../src/services/postRelations';

import {
  buildTestApp,
  registerFixtureFile,
  seedUser,
  writeFixtureFile
} from './helpers/testApp';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

const seedFile = async (username: string) => {
  const seeded = await seedUser({ username });
  const site = await booruSitesRepo.insertBooruSite(
    {
      name: 'Danbooru',
      engine: 'danbooru',
      baseUrl: 'https://danbooru.donmai.us',
      isPreset: false,
      enabled: true
    },
    seeded.user.id
  );
  const folder = (await foldersRepo.listFolders(seeded.user.id))[0];
  const file = await registerFixtureFile(
    folder.id,
    writeFixtureFile(seeded.libraryRoot, `${username}.png`, 'x')
  );
  return { userId: seeded.user.id, site, file };
};

test('a favourited file keeps its post without any source tags', async () => {
  const { userId, site, file } = await seedFile('origins_favorite');
  await favoritesRepo.upsertFavoriteItem(
    { provider: site.id, remoteId: '42', filePath: file.path },
    userId
  );

  const origins = await remoteOrigins(file.id, userId);

  assert.deepEqual(
    origins.map((origin) => [origin.site.id, origin.remoteId]),
    [[site.id, '42']]
  );
});

test('a post already read for relations stays an origin', async () => {
  const { userId, site, file } = await seedFile('origins_stored');
  await filesRepo.upsertFileRelation({
    fileId: file.id,
    source: site.id,
    remoteId: '7',
    parentId: null,
    hasChildren: true,
    poolIds: []
  });

  const origins = await remoteOrigins(file.id, userId);

  assert.deepEqual(
    origins.map((origin) => origin.remoteId),
    ['7']
  );
});
