import type { FilePostRelationRecord } from '../../../db/types';

import { chunkIds, sqlite, withSqliteRetry } from './shared';

type FileRelationRow = {
  file_id: string;
  source: string;
  remote_id: string;
  parent_id: string | null;
  has_children: number;
  pool_ids: string | null;
  updated_at: string;
};

const mapRow = (row: FileRelationRow): FilePostRelationRecord => ({
  fileId: row.file_id,
  source: row.source,
  remoteId: row.remote_id,
  parentId: row.parent_id ?? null,
  hasChildren: Boolean(row.has_children),
  poolIds:
    row.pool_ids === null
      ? null
      : row.pool_ids.split(',').filter((id) => id.length > 0),
  updatedAt: row.updated_at
});

export const listRelationsForFile = async (
  fileId: string
): Promise<FilePostRelationRecord[]> => {
  const rows = sqlite
    .prepare('SELECT * FROM file_post_relations WHERE file_id = ?')
    .all(fileId) as FileRelationRow[];
  return rows.map(mapRow);
};

/**
 * Of the given files, the ones the grid has to mark: a post with a parent or
 * with children. A file whose post stands alone has a row too — that is how
 * a second read is avoided — and is deliberately not returned here.
 */
export const listFileIdsWithRelatives = async (
  fileIds: string[]
): Promise<Set<string>> => {
  const found = new Set<string>();
  for (const slice of chunkIds(fileIds)) {
    const placeholders = slice.map(() => '?').join(',');
    const rows = sqlite
      .prepare(
        `SELECT DISTINCT file_id FROM file_post_relations
          WHERE file_id IN (${placeholders})
            AND (parent_id IS NOT NULL OR has_children = 1)`
      )
      .all(...slice) as { file_id: string }[];
    for (const row of rows) found.add(row.file_id);
  }
  return found;
};

export const upsertFileRelation = async (
  relation: Omit<FilePostRelationRecord, 'updatedAt'>
): Promise<void> => {
  const now = new Date().toISOString();
  await withSqliteRetry(() =>
    sqlite
      .prepare(
        `INSERT INTO file_post_relations
           (file_id, source, remote_id, parent_id, has_children, pool_ids,
            updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id, source) DO UPDATE SET
           remote_id = excluded.remote_id,
           parent_id = excluded.parent_id,
           has_children = excluded.has_children,
           pool_ids = excluded.pool_ids,
           updated_at = excluded.updated_at`
      )
      .run(
        relation.fileId,
        relation.source,
        relation.remoteId,
        relation.parentId,
        relation.hasChildren ? 1 : 0,
        relation.poolIds === null ? null : relation.poolIds.join(','),
        now
      )
  );
};
