import { randomUUID } from 'crypto';

import type { FileRecord } from '../../../db/types';
import type { MediaKind, ScannedFile } from '../../../lib/scanner';

import {
  buildFileOrder,
  buildFileTagFilter,
  buildFileWhereClause,
  chunkIds,
  buildPaginationClause,
  mapFileRow,
  mapFileRowWithVote,
  mapProviderRunRow,
  nextVoteAtFrom,
  sqlite,
  withSqliteRetry,
  VOTE_COOLDOWN_MS,
  type FileBatchCursor,
  type FileListOptions,
  type FileRow,
  type FileWithVoteRow,
  type ProviderRunRow
} from './shared';

export const listFilesPage = async (
  options: FileListOptions = {},
  userId?: string
) => {
  const tagFilter = buildFileTagFilter(options.tagQuery);
  const tagWhere = {
    conditions: tagFilter.where,
    params: tagFilter.whereParams
  };
  const countWhere = buildFileWhereClause(options, userId, tagWhere);
  const countSql = `
    SELECT COUNT(*) AS total
    FROM files f
    ${tagFilter.join}
    ${countWhere.clause}
  `;
  const countRow = sqlite
    .prepare(countSql)
    .get(...tagFilter.joinParams, ...countWhere.params) as
    { total?: number } | undefined;
  const total = Number(countRow?.total ?? 0);

  const order = buildFileOrder(options.sort, options.seed);
  const pageWhere = buildFileWhereClause(options, userId, tagWhere);
  const pagination = buildPaginationClause(options.limit, options.offset);
  const pageSql = `
    SELECT f.*, v.score AS vote_score, v.last_vote_at
    FROM files f
    ${tagFilter.join}
    LEFT JOIN file_votes v ON v.file_id = f.id
    ${order.join}
    ${pageWhere.clause}
    ORDER BY ${order.clause}
    ${pagination.clause}
  `;
  const rows = sqlite
    .prepare(pageSql)
    .all(
      ...tagFilter.joinParams,
      ...pageWhere.params,
      ...order.params,
      ...pagination.params
    ) as FileWithVoteRow[];
  return {
    files: rows.map(mapFileRowWithVote),
    total
  };
};

export const listVotesByFileIds = async (fileIds: string[]) => {
  const votes = new Map<string, { score: number; lastVoteAt: string }>();
  for (const slice of chunkIds(fileIds)) {
    const placeholders = slice.map(() => '?').join(',');
    const rows = sqlite
      .prepare(
        `SELECT file_id, score, last_vote_at FROM file_votes WHERE file_id IN (${placeholders})`
      )
      .all(...slice) as {
      file_id: string;
      score: number;
      last_vote_at: string;
    }[];
    for (const row of rows) {
      votes.set(row.file_id, {
        score: Number(row.score),
        lastVoteAt: row.last_vote_at
      });
    }
  }
  return votes;
};

export const listFilesWithProviderRuns = async (
  folderId?: string,
  userId?: string
) => {
  let rows: FileRow[];

  if (folderId && userId) {
    rows = sqlite
      .prepare(
        `SELECT * FROM files WHERE folder_id = ? AND folder_id IN (SELECT id FROM folders WHERE user_id = ?) ORDER BY created_at DESC`
      )
      .all(folderId, userId) as FileRow[];
  } else if (folderId) {
    rows = sqlite
      .prepare(
        'SELECT * FROM files WHERE folder_id = ? ORDER BY created_at DESC'
      )
      .all(folderId) as FileRow[];
  } else if (userId) {
    rows = sqlite
      .prepare(
        `SELECT * FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?) ORDER BY created_at DESC`
      )
      .all(userId) as FileRow[];
  } else {
    rows = sqlite
      .prepare('SELECT * FROM files ORDER BY created_at DESC')
      .all() as FileRow[];
  }

  const files = rows.map(mapFileRow);
  const providerRunsByFile: Record<
    string,
    ReturnType<typeof mapProviderRunRow>[]
  > = {};
  let votes = new Map<string, { score: number; lastVoteAt: string }>();

  if (files.length) {
    const ids = files.map((file) => file.id);
    votes = await listVotesByFileIds(ids);
    const runRows: ProviderRunRow[] = [];
    for (const slice of chunkIds(ids)) {
      const placeholders = slice.map(() => '?').join(',');
      const rows = sqlite
        .prepare(
          `SELECT * FROM provider_runs WHERE file_id IN (${placeholders})`
        )
        .all(...slice) as ProviderRunRow[];
      runRows.push(...rows);
    }
    for (const row of runRows) {
      const run = mapProviderRunRow(row);
      if (!providerRunsByFile[run.fileId]) providerRunsByFile[run.fileId] = [];
      providerRunsByFile[run.fileId].push(run);
    }
  }

  return {
    files: files.map((file) => ({
      ...file,
      voteScore: votes.get(file.id)?.score ?? 0,
      nextVoteAt: nextVoteAtFrom(votes.get(file.id)?.lastVoteAt)
    })),
    providerRunsByFile
  };
};

export const upsertFile = async (folderId: string, file: ScannedFile) => {
  const existingRow = sqlite
    .prepare('SELECT * FROM files WHERE folder_id = ? AND path = ?')
    .get(folderId, file.path) as FileRow | undefined;
  const now = new Date().toISOString();

  if (existingRow) {
    const existing = mapFileRow(existingRow);
    const updated: FileRecord = {
      ...existing,
      locationType: file.locationType,
      sizeBytes: Number(file.sizeBytes),
      mtime: file.mtime.toISOString(),
      sha256: file.sha256,
      phash: file.phash ?? existing.phash,
      mediaType: file.mediaType,
      width: file.width,
      height: file.height,
      durationMs: file.durationMs,
      thumbPath: file.thumbPath ?? existing.thumbPath,
      updatedAt: now
    };
    sqlite
      .prepare(
        `UPDATE files SET location_type = ?, size_bytes = ?, mtime = ?, sha256 = ?, phash = ?, media_type = ?, width = ?, height = ?, duration_ms = ?, thumb_path = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        updated.locationType,
        updated.sizeBytes,
        updated.mtime,
        updated.sha256,
        updated.phash,
        updated.mediaType,
        updated.width,
        updated.height,
        updated.durationMs,
        updated.thumbPath,
        updated.updatedAt,
        updated.id
      );
    return updated;
  }

  const record: FileRecord = {
    id: randomUUID(),
    folderId,
    locationType: file.locationType,
    path: file.path,
    sizeBytes: Number(file.sizeBytes),
    mtime: file.mtime.toISOString(),
    sha256: file.sha256,
    phash: file.phash,
    mediaType: file.mediaType,
    width: file.width,
    height: file.height,
    durationMs: file.durationMs,
    thumbPath: file.thumbPath,
    createdAt: now,
    updatedAt: now
  };
  sqlite
    .prepare(
      `INSERT INTO files (id, folder_id, location_type, path, size_bytes, mtime, sha256, phash, media_type, width, height, duration_ms, thumb_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.folderId,
      record.locationType,
      record.path,
      record.sizeBytes,
      record.mtime,
      record.sha256,
      record.phash,
      record.mediaType,
      record.width,
      record.height,
      record.durationMs,
      record.thumbPath,
      record.createdAt,
      record.updatedAt
    );
  return record;
};

export const listFiles = async (folderId?: string, userId?: string) => {
  let rows: FileRow[];
  if (folderId && userId) {
    rows = sqlite
      .prepare(
        `SELECT * FROM files WHERE folder_id = ? AND folder_id IN (SELECT id FROM folders WHERE user_id = ?) ORDER BY created_at DESC`
      )
      .all(folderId, userId) as FileRow[];
  } else if (folderId) {
    rows = sqlite
      .prepare(
        'SELECT * FROM files WHERE folder_id = ? ORDER BY created_at DESC'
      )
      .all(folderId) as FileRow[];
  } else if (userId) {
    rows = sqlite
      .prepare(
        `SELECT * FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?) ORDER BY created_at DESC`
      )
      .all(userId) as FileRow[];
  } else {
    rows = sqlite
      .prepare('SELECT * FROM files ORDER BY created_at DESC')
      .all() as FileRow[];
  }
  return rows.map(mapFileRow);
};

export const listFilesBatch = async (
  options?: {
    limit?: number;
    after?: FileBatchCursor | null;
    mediaType?: MediaKind;
  },
  userId?: string
) => {
  const limit = Math.max(1, Math.min(options?.limit ?? 100, 500));
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (userId) {
    where.push('folder_id IN (SELECT id FROM folders WHERE user_id = ?)');
    params.push(userId);
  }
  if (options?.mediaType) {
    where.push('media_type = ?');
    params.push(options.mediaType);
  }
  if (options?.after) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(
      options.after.createdAt,
      options.after.createdAt,
      options.after.id
    );
  }
  const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = sqlite
    .prepare(
      `SELECT * FROM files${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(...params, limit) as FileRow[];
  const files = rows.map(mapFileRow);
  const last = files[files.length - 1];
  return {
    files,
    nextCursor:
      files.length === limit && last
        ? ({ createdAt: last.createdAt, id: last.id } as FileBatchCursor)
        : null
  };
};

export const listFilesWithoutProviderRun = (
  provider: string,
  limit = 100,
  userId?: string
): FileRecord[] => {
  const rows = userId
    ? (sqlite
        .prepare(
          `SELECT f.* FROM files f
           LEFT JOIN provider_runs pr ON pr.file_id = f.id AND pr.provider = ?
           WHERE pr.file_id IS NULL
             AND f.folder_id IN (SELECT id FROM folders WHERE user_id = ?)
           ORDER BY RANDOM()
           LIMIT ?`
        )
        .all(provider, userId, limit) as FileRow[])
    : (sqlite
        .prepare(
          `SELECT f.* FROM files f
           LEFT JOIN provider_runs pr ON pr.file_id = f.id AND pr.provider = ?
           WHERE pr.file_id IS NULL
           ORDER BY RANDOM()
           LIMIT ?`
        )
        .all(provider, limit) as FileRow[]);
  return rows.map(mapFileRow);
};

export type FileVoteResult = {
  applied: boolean;
  /** Why the vote was refused; absent when it landed. */
  reason?: 'floor' | 'cooldown';
  voteScore: number;
  nextVoteAt: string | null;
};

/**
 * Adds `delta` (+1 or -1) to a file's score, at most once per
 * VOTE_COOLDOWN_MS and never below zero. Returns the current score either
 * way, so a refused vote can still refresh the caller's view.
 */
export const applyFileVote = async (
  fileId: string,
  delta: 1 | -1
): Promise<FileVoteResult> =>
  withSqliteRetry(() => {
    const tx = sqlite.transaction((): FileVoteResult => {
      const row = sqlite
        .prepare('SELECT score, last_vote_at FROM file_votes WHERE file_id = ?')
        .get(fileId) as { score: number; last_vote_at: string } | undefined;
      const now = Date.now();
      const current = Number(row?.score ?? 0);
      // Checked before the cooldown: a downvote at zero is never valid, while
      // the cooldown is only about timing.
      if (delta === -1 && current === 0) {
        return {
          applied: false,
          reason: 'floor',
          voteScore: current,
          nextVoteAt: nextVoteAtFrom(row?.last_vote_at)
        };
      }
      const votedAt = row ? Date.parse(row.last_vote_at) : Number.NaN;
      if (row && !Number.isNaN(votedAt) && now - votedAt < VOTE_COOLDOWN_MS) {
        return {
          applied: false,
          reason: 'cooldown',
          voteScore: current,
          nextVoteAt: nextVoteAtFrom(row.last_vote_at)
        };
      }
      const nowIso = new Date(now).toISOString();
      const score = current + delta;
      sqlite
        .prepare(
          `INSERT INTO file_votes (file_id, score, last_vote_at)
           VALUES (?, ?, ?)
           ON CONFLICT(file_id) DO UPDATE SET score = excluded.score, last_vote_at = excluded.last_vote_at`
        )
        .run(fileId, score, nowIso);
      return {
        applied: true,
        voteScore: score,
        nextVoteAt: nextVoteAtFrom(nowIso)
      };
    });
    return tx();
  });

export const findFileById = async (id: string, userId?: string) => {
  const row = (
    userId
      ? sqlite
          .prepare(
            `SELECT fi.*
         FROM files fi
         JOIN folders f ON f.id = fi.folder_id
         WHERE fi.id = ? AND f.user_id = ?`
          )
          .get(id, userId)
      : sqlite.prepare('SELECT * FROM files WHERE id = ?').get(id)
  ) as FileRow | undefined;
  return row ? mapFileRow(row) : null;
};

export const findFileByPath = async (filePath: string, userId?: string) => {
  const row = (
    userId
      ? sqlite
          .prepare(
            `SELECT fi.*
         FROM files fi
         JOIN folders f ON f.id = fi.folder_id
         WHERE fi.path = ? AND f.user_id = ?`
          )
          .get(filePath, userId)
      : sqlite.prepare('SELECT * FROM files WHERE path = ?').get(filePath)
  ) as FileRow | undefined;
  return row ? mapFileRow(row) : null;
};

export const deleteFile = async (id: string) => {
  const file = await findFileById(id);
  if (!file) return null;
  sqlite.prepare('DELETE FROM files WHERE id = ?').run(id);
  return file;
};
