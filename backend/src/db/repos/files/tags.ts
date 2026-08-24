import type { TagSource } from '../../../db/types';
import { canonicalTag } from '../../../services/tagDb';

import { sqlite, mapTagRow, withSqliteRetry, type FileTagRow } from './shared';

export const listTagsForFile = async (fileId: string) => {
  const rows = sqlite
    .prepare('SELECT * FROM file_tags WHERE file_id = ? ORDER BY tag ASC')
    .all(fileId) as FileTagRow[];
  return rows.map(mapTagRow);
};

export const clearTagsForFile = async (fileId: string) => {
  const result = sqlite
    .prepare('DELETE FROM file_tags WHERE file_id = ?')
    .run(fileId);
  return result.changes ?? 0;
};

export const removeTagsBySourceUrl = async (
  fileId: string,
  sourceUrl: string
) => {
  sqlite
    .prepare('DELETE FROM file_tags WHERE file_id = ? AND source_url = ?')
    .run(fileId, sourceUrl);
};

export const replaceTagsForSource = async (
  fileId: string,
  source: TagSource,
  tags: {
    tag: string;
    category: string;
    score?: number | null;
    sourceUrl?: string | null;
  }[]
) => {
  const now = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    const fileExists = sqlite
      .prepare('SELECT 1 FROM files WHERE id = ?')
      .get(fileId) as { 1?: number } | undefined;
    if (!fileExists) return;
    sqlite
      .prepare('DELETE FROM file_tags WHERE file_id = ? AND source = ?')
      .run(fileId, source);
    if (!tags.length) return;
    const insert = sqlite.prepare(
      `INSERT INTO file_tags (file_id, tag, canonical_tag, category, source, score, source_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of tags) {
      insert.run(
        fileId,
        item.tag,
        canonicalTag(item.tag),
        item.category,
        source,
        item.score ?? null,
        item.sourceUrl ?? null,
        now,
        now
      );
    }
  });
  await withSqliteRetry(() => tx());
};

export const addManualTag = async (
  fileId: string,
  tag: string,
  category: string
) => {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO file_tags (file_id, tag, canonical_tag, category, source, score, source_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'MANUAL', NULL, NULL, ?, ?)
     ON CONFLICT(file_id, tag, source) DO UPDATE SET canonical_tag = excluded.canonical_tag, category = excluded.category, updated_at = excluded.updated_at`
    )
    .run(fileId, tag, canonicalTag(tag), category, now, now);
};

export const removeManualTag = async (fileId: string, tag: string) => {
  sqlite
    .prepare(
      'DELETE FROM file_tags WHERE file_id = ? AND tag = ? AND source = ?'
    )
    .run(fileId, tag, 'MANUAL');
};
