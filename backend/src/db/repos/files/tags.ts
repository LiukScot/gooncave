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

export const saveManualOrder = async (fileIds: string[], userId?: string) =>
  withSqliteRetry(() => {
    const now = new Date().toISOString();
    const tx = sqlite.transaction((order: string[], scopedUserId?: string) => {
      if (order.length === 0) {
        if (scopedUserId) {
          sqlite.prepare(
            `DELETE FROM file_manual_order
             WHERE file_id IN (SELECT id FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?))`
          ).run(scopedUserId);
        } else {
          sqlite.prepare('DELETE FROM file_manual_order').run();
        }
        return { saved: 0 };
      }

      const placeholders = order.map(() => '?').join(',');
      const existingRows = (scopedUserId
        ? sqlite
            .prepare(
              `SELECT id FROM files
               WHERE id IN (${placeholders})
                 AND folder_id IN (SELECT id FROM folders WHERE user_id = ?)`
            )
            .all(...order, scopedUserId)
        : sqlite.prepare(`SELECT id FROM files WHERE id IN (${placeholders})`).all(...order)) as { id: string }[];
      const existing = new Set(existingRows.map((row) => row.id));
      const validOrder = order.filter((id) => existing.has(id));

      if (validOrder.length === 0) {
        if (scopedUserId) {
          sqlite.prepare(
            `DELETE FROM file_manual_order
             WHERE file_id IN (SELECT id FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?))`
          ).run(scopedUserId);
        } else {
          sqlite.prepare('DELETE FROM file_manual_order').run();
        }
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

      if (scopedUserId) {
        const validPlaceholders = validOrder.map(() => '?').join(',');
        sqlite.prepare(
          `DELETE FROM file_manual_order
           WHERE file_id IN (SELECT id FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?))
             AND file_id NOT IN (${validPlaceholders})`
        ).run(scopedUserId, ...validOrder);
      } else {
        const validPlaceholders = validOrder.map(() => '?').join(',');
        sqlite.prepare(`DELETE FROM file_manual_order WHERE file_id NOT IN (${validPlaceholders})`).run(...validOrder);
      }

      return { saved: validOrder.length };
    });

    return tx(fileIds, userId);
  });
