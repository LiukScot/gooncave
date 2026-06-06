// Unit contract for deleteFileRecord — the worker that auto-resolve uses to
// delete a losing duplicate. Two security properties live here:
//   1. ownership scope: a file is only deletable by its owner (userId).
//   2. thumbPath containment: a forged/corrupted thumbPath in the DB must
//      never let unlink escape the configured thumbnails dir.
import './helpers/setupEnv';

import fs from 'fs';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import path from 'path';

import { config } from '../src/config';
import { filesRepo } from '../src/db/repos/filesRepo';
import { deleteFileRecord } from '../src/services/duplicateResolver';

import {
  registerFixtureFile,
  seedUser,
  writeFixtureFile
} from './helpers/testApp';

const folderIdFor = async (userId: string) => {
  const { foldersRepo } = await import('../src/db/repos/foldersRepo');
  const folders = await foldersRepo.listFolders(userId);
  return folders[0].id;
};

let thumbsDir: string;

before(async () => {
  thumbsDir = path.resolve(config.storage.thumbnailsDir);
  await fs.promises.mkdir(thumbsDir, { recursive: true });
});

after(() => undefined);

test('deleteFileRecord refuses to act on another user’s file', async () => {
  const alice = await seedUser({ username: 'dr_owner_a' });
  const bob = await seedUser({ username: 'dr_owner_b' });
  const aliceFolder = await folderIdFor(alice.user.id);
  const filePath = writeFixtureFile(alice.libraryRoot, 'owned.png', 'data');
  const record = await registerFixtureFile(aliceFolder, filePath);

  // Bob tries to delete Alice's file: must be denied and the file must survive.
  const ok = await deleteFileRecord(record.id, bob.user.id);
  assert.equal(ok, false);
  assert.equal(fs.existsSync(filePath), true);
  assert.notEqual(await filesRepo.findFileById(record.id, alice.user.id), null);
});

test('deleteFileRecord blocks a thumbPath pointing outside the thumbnails dir', async () => {
  const user = await seedUser({ username: 'dr_thumb_evil' });
  const folderId = await folderIdFor(user.user.id);
  const filePath = writeFixtureFile(user.libraryRoot, 'evil.png', 'data');

  // A sentinel "victim" file outside the thumbnails dir that must NOT be
  // deleted, even though the DB record points at it via a traversal path.
  const victim = writeFixtureFile(user.libraryRoot, 'victim.txt', 'keep me');
  const traversal = path.relative(process.cwd(), victim);
  const record = await registerFixtureFile(folderId, filePath, {
    thumbPath: traversal
  });

  const ok = await deleteFileRecord(record.id, user.user.id);
  assert.equal(ok, false);
  // Guard tripped: victim untouched and the DB row is still present.
  assert.equal(fs.existsSync(victim), true);
  assert.notEqual(await filesRepo.findFileById(record.id, user.user.id), null);
});

test('deleteFileRecord unlinks a thumbPath that is inside the thumbnails dir', async () => {
  const user = await seedUser({ username: 'dr_thumb_ok' });
  const folderId = await folderIdFor(user.user.id);
  const filePath = writeFixtureFile(user.libraryRoot, 'good.png', 'data');
  const thumbName = `good-${Date.now()}.jpg`;
  const thumbPath = writeFixtureFile(thumbsDir, thumbName, 'thumb');
  const record = await registerFixtureFile(folderId, filePath, { thumbPath });

  const ok = await deleteFileRecord(record.id, user.user.id);
  assert.equal(ok, true);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(thumbPath), false);
  assert.equal(await filesRepo.findFileById(record.id, user.user.id), null);
});
