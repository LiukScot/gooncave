import type { TagSource } from '../../../db/types';
import { canonicalTag, importedCategory } from '../../../services/tagDb';

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

/**
 * The posts one booru source tagged in the caller's library, as the file and
 * the post URL its tags were read from.
 *
 * `stale` narrows it to the ones worth reading again: every tag from that
 * source filed under 'general', which is what a post looks like when it was
 * read before the engine could see categories — or when the site answered
 * without them.
 *
 * Scoped through folders: file_tags has no owner of its own, and one user's
 * library must never reach another's.
 */
export const listSourceTagTargets = async (
  userId: string,
  source: TagSource,
  options: { stale?: boolean } = {}
) => {
  const rows = sqlite
    .prepare(
      `SELECT t.file_id AS fileId, MAX(t.source_url) AS sourceUrl
         FROM file_tags t
         JOIN files f ON f.id = t.file_id
         JOIN folders fo ON fo.id = f.folder_id
        WHERE t.source = ?
          AND fo.user_id = ?
          AND t.source_url IS NOT NULL
        GROUP BY t.file_id
        ${options.stale ? "HAVING SUM(CASE WHEN t.category <> 'general' THEN 1 ELSE 0 END) = 0" : ''}
        ORDER BY t.file_id`
    )
    .all(source, userId) as { fileId: string; sourceUrl: string }[];
  return rows;
};

export const removeTagsBySourceUrl = async (
  fileId: string,
  sourceUrl: string
) => {
  sqlite
    .prepare('DELETE FROM file_tags WHERE file_id = ? AND source_url = ?')
    .run(fileId, sourceUrl);
};

/**
 * 'general' is what every engine falls back to when the booru gave no
 * category, so it doubles as "unknown" and the imported map may improve on
 * it. A category the booru did state is left alone: it knows its own post
 * better than a vocabulary-wide table does.
 */
const bestCategory = (tag: string, category: string): string =>
  category === 'general' ? (importedCategory(tag) ?? 'general') : category;

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
        bestCategory(item.tag, item.category),
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
