// Contract for saveManualOrder, with focus on the SQLite parameter-limit fix
// (issue #200 finding 5): a reorder spanning more ids than
// SQLITE_MAX_VARIABLE_NUMBER must not throw and must persist the full order.
import './helpers/setupEnv';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { afterEach, test } from 'bun:test';

import { sqlite } from '../src/db/repos/files/shared';
import { filesRepo } from '../src/db/repos/filesRepo';

const now = new Date().toISOString();

const seedUser = () => {
  const userId = randomUUID();
  const folderId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO users (id, username, password_hash, library_root, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, `u-${userId}`, 'x', '/tmp', now, now);
  sqlite
    .prepare(
      `INSERT INTO folders (id, user_id, path, type, created_at, updated_at, status)
       VALUES (?, ?, ?, 'LOCAL', ?, ?, 'READY')`
    )
    .run(folderId, userId, `/tmp/${folderId}`, now, now);
  return { userId, folderId };
};

const seedFiles = (folderId: string, count: number): string[] => {
  const insert = sqlite.prepare(
    `INSERT INTO files (id, folder_id, location_type, path, size_bytes, mtime, sha256, media_type, created_at, updated_at)
     VALUES (?, ?, 'LOCAL', ?, 0, ?, ?, 'IMAGE', ?, ?)`
  );
  const ids: string[] = [];
  const tx = sqlite.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const id = randomUUID();
      ids.push(id);
      insert.run(id, folderId, `/tmp/${id}.jpg`, now, id, now, now);
    }
  });
  tx();
  return ids;
};

afterEach(() => {
  sqlite.prepare('DELETE FROM file_manual_order').run();
  sqlite.prepare('DELETE FROM files').run();
  sqlite.prepare('DELETE FROM folders').run();
  sqlite.prepare('DELETE FROM users').run();
});

test('saveManualOrder persists an order larger than the SQLite param limit', async () => {
  const { userId, folderId } = seedUser();
  // > 500 (chunk size) and > the historical 999-variable default, so the
  // pre-fix single IN clause would have failed here.
  const ids = seedFiles(folderId, 1200);

  const result = await filesRepo.saveManualOrder(ids, userId);
  assert.equal(result.saved, 1200);

  const rows = sqlite
    .prepare('SELECT file_id, position FROM file_manual_order ORDER BY position ASC')
    .all() as { file_id: string; position: number }[];
  assert.equal(rows.length, 1200);
  assert.equal(rows[0].file_id, ids[0]);
  assert.equal(rows[rows.length - 1].file_id, ids[ids.length - 1]);
});

test('saveManualOrder drops stale rows not present in the new large order', async () => {
  const { userId, folderId } = seedUser();
  const ids = seedFiles(folderId, 800);

  await filesRepo.saveManualOrder(ids, userId);
  // Reorder to a subset: the other 400 must be removed from file_manual_order.
  const subset = ids.slice(0, 400);
  const result = await filesRepo.saveManualOrder(subset, userId);
  assert.equal(result.saved, 400);

  const remaining = sqlite
    .prepare('SELECT COUNT(1) AS c FROM file_manual_order')
    .get() as { c: number };
  assert.equal(remaining.c, 400);
});

test('saveManualOrder ignores ids that do not belong to the user', async () => {
  const { userId, folderId } = seedUser();
  const ids = seedFiles(folderId, 3);
  const stranger = randomUUID();

  const result = await filesRepo.saveManualOrder([...ids, stranger], userId);
  assert.equal(result.saved, 3);

  const stored = sqlite
    .prepare('SELECT file_id FROM file_manual_order WHERE file_id = ?')
    .get(stranger);
  assert.equal(stored, null);
});
