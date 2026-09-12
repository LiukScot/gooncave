import { sqlite } from '../client';

import { chunkIds } from './files/shared';

/** Local library file (keyed by files.id) or explore post ("<siteId>:<remoteId>"). */
export type ReadScope = 'file' | 'post';

export const readMarksRepo = {
  /** Records items as read. Re-marking an item only refreshes its timestamp. */
  markRead(userId: string, scope: ReadScope, keys: readonly string[]): number {
    const unique = [...new Set(keys)];
    if (!unique.length) return 0;
    const now = new Date().toISOString();
    const statement = sqlite.prepare(
      `INSERT INTO read_marks (scope, item_key, user_id, read_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, item_key, user_id) DO UPDATE SET read_at = excluded.read_at`
    );
    const tx = sqlite.transaction(() => {
      for (const key of unique) statement.run(scope, key, userId, now);
    });
    tx();
    return unique.length;
  },

  /**
   * Which of these keys the user has already read. Explore asks about the
   * forty posts on one page; reading the whole set instead would grow with
   * the history rather than the page.
   */
  listReadKeys(
    userId: string,
    scope: ReadScope,
    keys: readonly string[]
  ): Set<string> {
    const read = new Set<string>();
    for (const slice of chunkIds([...keys])) {
      const placeholders = slice.map(() => '?').join(',');
      const rows = sqlite
        .prepare(
          `SELECT item_key FROM read_marks
            WHERE scope = ? AND user_id = ? AND item_key IN (${placeholders})`
        )
        .all(scope, userId, ...slice) as { item_key: string }[];
      for (const row of rows) read.add(row.item_key);
    }
    return read;
  },

  clearRead(userId: string, scope: ReadScope): number {
    const result = sqlite
      .prepare('DELETE FROM read_marks WHERE scope = ? AND user_id = ?')
      .run(scope, userId);
    return result.changes ?? 0;
  },

  /**
   * Drops every user's marks for these files. Called wherever file rows go
   * away: read_marks carries no foreign key to files, because the same table
   * also holds remote posts that have no row to reference.
   */
  forgetFiles(fileIds: readonly string[]): void {
    if (!fileIds.length) return;
    for (const slice of chunkIds([...fileIds])) {
      const placeholders = slice.map(() => '?').join(',');
      sqlite
        .prepare(
          `DELETE FROM read_marks
            WHERE scope = 'file' AND item_key IN (${placeholders})`
        )
        .run(...slice);
    }
  }
};
