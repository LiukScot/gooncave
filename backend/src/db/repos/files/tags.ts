import type { TagSource } from '../../../db/types';

import { sqlite, mapTagRow, withSqliteRetry, type FileTagRow } from './shared';

export const listTagsForFile = async (fileId: string) => {
  const rows = sqlite.prepare('SELECT * FROM file_tags WHERE file_id = ? ORDER BY tag ASC').all(fileId) as FileTagRow[];
  return rows.map(mapTagRow);
};

export const clearTagsForFile = async (fileId: string) => {
  const result = sqlite.prepare('DELETE FROM file_tags WHERE file_id = ?').run(fileId);
  return result.changes ?? 0;
};

export const removeTagsBySourceUrl = async (fileId: string, sourceUrl: string) => {
  sqlite.prepare('DELETE FROM file_tags WHERE file_id = ? AND source_url = ?').run(fileId, sourceUrl);
};

export const replaceTagsForSource = async (
  fileId: string,
  source: TagSource,
  tags: { tag: string; category: string; score?: number | null; sourceUrl?: string | null }[]
) => {
  const now = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    const fileExists = sqlite.prepare('SELECT 1 FROM files WHERE id = ?').get(fileId) as { 1?: number } | undefined;
    if (!fileExists) return;
    sqlite.prepare('DELETE FROM file_tags WHERE file_id = ? AND source = ?').run(fileId, source);
    if (!tags.length) return;
    const insert = sqlite.prepare(
      `INSERT INTO file_tags (file_id, tag, category, source, score, source_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of tags) {
      insert.run(fileId, item.tag, item.category, source, item.score ?? null, item.sourceUrl ?? null, now, now);
    }
  });
  await withSqliteRetry(() => tx());
};

export const addManualTag = async (fileId: string, tag: string, category: string) => {
  const now = new Date().toISOString();
  sqlite.prepare(
    `INSERT INTO file_tags (file_id, tag, category, source, score, source_url, created_at, updated_at)
     VALUES (?, ?, ?, 'MANUAL', NULL, NULL, ?, ?)
     ON CONFLICT(file_id, tag, source) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at`
  ).run(fileId, tag, category, now, now);
};

export const removeManualTag = async (fileId: string, tag: string) => {
  sqlite.prepare('DELETE FROM file_tags WHERE file_id = ? AND tag = ? AND source = ?').run(fileId, tag, 'MANUAL');
};

// SQLite caps the number of bound parameters per statement
// (SQLITE_MAX_VARIABLE_NUMBER). Splitting id lists into batches keeps every IN
// clause under that limit even when reordering a very large library.
const SQLITE_PARAM_CHUNK = 500;

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

export const saveManualOrder = async (fileIds: string[], userId?: string) =>
  withSqliteRetry(() => {
    const now = new Date().toISOString();
    const tx = sqlite.transaction((order: string[], scopedUserId?: string) => {
      const clearAll = () => {
        if (scopedUserId) {
          sqlite.prepare(
            `DELETE FROM file_manual_order
             WHERE file_id IN (SELECT id FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?))`
          ).run(scopedUserId);
        } else {
          sqlite.prepare('DELETE FROM file_manual_order').run();
        }
      };

      if (order.length === 0) {
        clearAll();
        return { saved: 0 };
      }

      const existing = new Set<string>();
      for (const batch of chunk(order, SQLITE_PARAM_CHUNK)) {
        const placeholders = batch.map(() => '?').join(',');
        const rows = (scopedUserId
          ? sqlite
              .prepare(
                `SELECT id FROM files
                 WHERE id IN (${placeholders})
                   AND folder_id IN (SELECT id FROM folders WHERE user_id = ?)`
              )
              .all(...batch, scopedUserId)
          : sqlite.prepare(`SELECT id FROM files WHERE id IN (${placeholders})`).all(...batch)) as { id: string }[];
        for (const row of rows) existing.add(row.id);
      }
      const validOrder = order.filter((id) => existing.has(id));

      if (validOrder.length === 0) {
        clearAll();
        return { saved: 0 };
      }

      const insert = sqlite.prepare(
        `INSERT INTO file_manual_order (file_id, position, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`
      );
      validOrder.forEach((id, index) => {
        insert.run(id, index + 1, now);
      });

      // Drop any previously-ordered rows that are not in the new order. Compute
      // the stale set in code and delete it in batches, rather than a single
      // NOT IN (...) — the kept list can be as large as the user's library and
      // would otherwise blow the parameter limit.
      const currentRows = (scopedUserId
        ? sqlite
            .prepare(
              `SELECT file_id FROM file_manual_order
               WHERE file_id IN (SELECT id FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?))`
            )
            .all(scopedUserId)
        : sqlite.prepare('SELECT file_id FROM file_manual_order').all()) as {
        file_id: string;
      }[];
      const keep = new Set(validOrder);
      const stale = currentRows
        .map((row) => row.file_id)
        .filter((id) => !keep.has(id));
      for (const batch of chunk(stale, SQLITE_PARAM_CHUNK)) {
        const placeholders = batch.map(() => '?').join(',');
        sqlite
          .prepare(`DELETE FROM file_manual_order WHERE file_id IN (${placeholders})`)
          .run(...batch);
      }

      return { saved: validOrder.length };
    });

    return tx(fileIds, userId);
  });
