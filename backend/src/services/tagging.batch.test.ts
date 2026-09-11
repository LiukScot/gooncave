import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';

import { afterEach, test } from 'bun:test';
// eslint-disable-next-line import-x/no-named-as-default
import sharp from 'sharp';

import { disarmFetchMock, setupFetchMock } from '../../test/helpers/fetchMock';
import {
  registerFixtureFile,
  seedUser,
  writeFixtureFile
} from '../../test/helpers/testApp';
import { filesRepo } from '../db/repos/filesRepo';
import { foldersRepo } from '../db/repos/foldersRepo';

import { ensureWd14TagsBatch, runWd14TaggerBatches } from './tagging';

afterEach(disarmFetchMock);

const createPng = () =>
  sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: '#000000'
    }
  })
    .png()
    .toBuffer();

test('WD14 backfill isolates an unreadable image from valid batch partners', async () => {
  const seeded = await seedUser({ username: 'tag_batch_isolation' });
  const folder = (await foldersRepo.listFolders(seeded.user.id))[0];
  const invalid = await registerFixtureFile(
    folder.id,
    writeFixtureFile(seeded.libraryRoot, 'invalid.png', 'not an image')
  );
  const valid = await registerFixtureFile(
    folder.id,
    writeFixtureFile(seeded.libraryRoot, 'valid.png', await createPng())
  );
  const fetchMock = setupFetchMock();
  fetchMock.intercept((url) => url.endsWith('/tag/batch'), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      results: [
        {
          tags: [{ tag: 'fox', category: 'general', score: 0.9 }]
        }
      ]
    })
  });

  await ensureWd14TagsBatch([invalid, valid]);

  const tags = await filesRepo.listTagsForFile(valid.id);
  assert.ok(tags.some((tag) => tag.source === 'WD14' && tag.tag === 'fox'));
});

test('WD14 tagging splits three video frames across batches of two', async () => {
  const seeded = await seedUser({ username: 'tag_video_batches' });
  const paths = await Promise.all(
    Array.from({ length: 3 }, async (_, index) =>
      writeFixtureFile(
        seeded.libraryRoot,
        `frame-${index}.png`,
        await createPng()
      )
    )
  );
  const fetchMock = setupFetchMock();
  fetchMock.intercept((url) => url.endsWith('/tag/batch'), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      results: [
        { tags: [{ tag: 'first', category: 'general', score: 0.9 }] },
        { tags: [{ tag: 'second', category: 'general', score: 0.8 }] }
      ]
    })
  });
  fetchMock.intercept((url) => url.endsWith('/tag/batch'), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      results: [{ tags: [{ tag: 'third', category: 'general', score: 0.7 }] }]
    })
  });

  const results = await runWd14TaggerBatches(paths);

  assert.deepEqual(
    results.map((tags) => tags[0]?.tag),
    ['first', 'second', 'third']
  );
});
