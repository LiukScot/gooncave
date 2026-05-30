import { randomUUID } from 'crypto';

import type { FileRecord } from '../../../db/types';
import type { MediaKind, ScannedFile } from '../../../lib/scanner';

import {
  buildFileOrder,
  buildFileTagJoin,
  buildFileWhereClause,
  buildPaginationClause,
  mapFileRow,
  mapFileRowWithFavorite,
  mapProviderRunRow,
  sqlite,
  type FileBatchCursor,
  type FileListOptions,
  type FileRow,
  type FileWithFavoriteRow,
  type ProviderRunRow
} from './shared';

export const listFilesPage = async (options: FileListOptions = {}, userId?: string) => {
  const normalizedTerms = (options.tagTerms ?? []).map((term) => term.trim()).filter(Boolean);
  const tagJoin = buildFileTagJoin(normalizedTerms);
  const selectFavoriteJoin = 'LEFT JOIN file_favorites ff ON ff.file_id = f.id';
  const countFavoriteJoin = options.favoritesOnly ? selectFavoriteJoin : '';
  const countWhere = buildFileWhereClause(options, 'ff', userId);
  const countSql = `
    SELECT COUNT(*) AS total
    FROM files f
    ${tagJoin.join}
    ${countFavoriteJoin}
    ${countWhere.clause}
  `;
  const countRow = sqlite.prepare(countSql).get(...tagJoin.params, ...countWhere.params) as { total?: number } | undefined;
  const total = Number(countRow?.total ?? 0);

  const order = buildFileOrder(options.sort, options.seed);
  const pageWhere = buildFileWhereClause(options, 'ff', userId);
  const pagination = buildPaginationClause(options.limit, options.offset);
  const pageSql = `
    SELECT f.*, CASE WHEN ff.file_id IS NULL THEN 0 ELSE 1 END AS is_favorite
    FROM files f
    ${tagJoin.join}
    ${selectFavoriteJoin}
    ${order.join}
    ${pageWhere.clause}
    ORDER BY ${order.clause}
    ${pagination.clause}
  `;
  const rows = sqlite
    .prepare(pageSql)
    .all(...tagJoin.params, ...pageWhere.params, ...order.params, ...pagination.params) as FileWithFavoriteRow[];
  return {
    files: rows.map(mapFileRowWithFavorite),
    total
  };
};

export const listFavoriteFileIds = async (fileIds: string[]) => {
  if (fileIds.length === 0) return new Set<string>();
  const placeholders = fileIds.map(() => '?').join(',');
  const rows = sqlite
    .prepare(`SELECT file_id FROM file_favorites WHERE file_id IN (${placeholders})`)
    .all(...fileIds) as { file_id: string }[];
  return new Set(rows.map((row) => row.file_id));
};

export const listFilesWithProviderRuns = async (folderId?: string, tagTerms?: string[], userId?: string) => {
  const normalizedTerms = (tagTerms ?? []).map((term) => term.trim()).filter(Boolean);
  let rows: FileRow[];

  if (normalizedTerms.length > 0) {
    const termPlaceholders = normalizedTerms.map(() => '?').join(',');
    const whereConditions: string[] = [];
    if (folderId) whereConditions.push('f.folder_id = ?');
    if (userId) whereConditions.push('f.folder_id IN (SELECT id FROM folders WHERE user_id = ?)');
    const whereFolder = whereConditions.length ? `${whereConditions.join(' AND ')} AND ` : '';
    const sql = `
      SELECT f.*
      FROM files f
      JOIN file_tags t ON t.file_id = f.id
      WHERE ${whereFolder}t.tag IN (${termPlaceholders})
      GROUP BY f.id
      HAVING COUNT(DISTINCT t.tag) = ?
      ORDER BY f.created_at DESC
    `;
    const params = [...(folderId ? [folderId] : []), ...(userId ? [userId] : []), ...normalizedTerms, normalizedTerms.length];
    rows = sqlite.prepare(sql).all(...params) as FileRow[];
  } else if (folderId && userId) {
    rows = sqlite
      .prepare(`SELECT * FROM files WHERE folder_id = ? AND folder_id IN (SELECT id FROM folders WHERE user_id = ?) ORDER BY created_at DESC`)
      .all(folderId, userId) as FileRow[];
  } else if (folderId) {
    rows = sqlite.prepare('SELECT * FROM files WHERE folder_id = ? ORDER BY created_at DESC').all(folderId) as FileRow[];
  } else if (userId) {
    rows = sqlite
      .prepare(`SELECT * FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?) ORDER BY created_at DESC`)
      .all(userId) as FileRow[];
  } else {
    rows = sqlite.prepare('SELECT * FROM files ORDER BY created_at DESC').all() as FileRow[];
  }

  const files = rows.map(mapFileRow);
  const providerRunsByFile: Record<string, ReturnType<typeof mapProviderRunRow>[]> = {};
  let favoriteIds = new Set<string>();

  if (files.length) {
    const ids = files.map((file) => file.id);
    favoriteIds = await listFavoriteFileIds(ids);
    const placeholders = ids.map(() => '?').join(',');
    const runRows = sqlite.prepare(`SELECT * FROM provider_runs WHERE file_id IN (${placeholders})`).all(...ids) as ProviderRunRow[];
    for (const row of runRows) {
      const run = mapProviderRunRow(row);
      if (!providerRunsByFile[run.fileId]) providerRunsByFile[run.fileId] = [];
      providerRunsByFile[run.fileId].push(run);
    }
  }

  return {
    files: files.map((file) => ({ ...file, isFavorite: favoriteIds.has(file.id) })),
    providerRunsByFile
  };
};

export const upsertFile = async (folderId: string, file: ScannedFile) => {
  const existingRow = sqlite.prepare('SELECT * FROM files WHERE folder_id = ? AND path = ?').get(folderId, file.path) as FileRow | undefined;
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
    sqlite.prepare(
      `UPDATE files SET location_type = ?, size_bytes = ?, mtime = ?, sha256 = ?, phash = ?, media_type = ?, width = ?, height = ?, duration_ms = ?, thumb_path = ?, updated_at = ? WHERE id = ?`
    ).run(
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
  sqlite.prepare(
    `INSERT INTO files (id, folder_id, location_type, path, size_bytes, mtime, sha256, phash, media_type, width, height, duration_ms, thumb_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
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
      .prepare(`SELECT * FROM files WHERE folder_id = ? AND folder_id IN (SELECT id FROM folders WHERE user_id = ?) ORDER BY created_at DESC`)
      .all(folderId, userId) as FileRow[];
  } else if (folderId) {
    rows = sqlite.prepare('SELECT * FROM files WHERE folder_id = ? ORDER BY created_at DESC').all(folderId) as FileRow[];
  } else if (userId) {
    rows = sqlite
      .prepare(`SELECT * FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?) ORDER BY created_at DESC`)
      .all(userId) as FileRow[];
  } else {
    rows = sqlite.prepare('SELECT * FROM files ORDER BY created_at DESC').all() as FileRow[];
  }
  return rows.map(mapFileRow);
};

export const listFilesBatch = async (
  options?: { limit?: number; after?: FileBatchCursor | null; mediaType?: MediaKind },
  userId?: string
) => {
  const limit = Math.max(1, Math.min(options?.limit ?? 100, 500));
  const where: string[] = [];
  const params: unknown[] = [];
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
    params.push(options.after.createdAt, options.after.createdAt, options.after.id);
  }
  const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = sqlite.prepare(`SELECT * FROM files${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit) as FileRow[];
  const files = rows.map(mapFileRow);
  const last = files[files.length - 1];
  return {
    files,
    nextCursor: files.length === limit && last ? ({ createdAt: last.createdAt, id: last.id } as FileBatchCursor) : null
  };
};

export const listFilesWithoutProviderRun = (provider: string, limit = 100, userId?: string): FileRecord[] => {
  const rows = userId
    ? (sqlite
        .prepare(
          `SELECT * FROM files
           WHERE id NOT IN (SELECT DISTINCT file_id FROM provider_runs WHERE provider = ?)
             AND folder_id IN (SELECT id FROM folders WHERE user_id = ?)
           ORDER BY RANDOM()
           LIMIT ?`
        )
        .all(provider, userId, limit) as FileRow[])
    : (sqlite
        .prepare(
          `SELECT * FROM files
           WHERE id NOT IN (SELECT DISTINCT file_id FROM provider_runs WHERE provider = ?)
           ORDER BY RANDOM()
           LIMIT ?`
        )
        .all(provider, limit) as FileRow[]);
  return rows.map(mapFileRow);
};

export const setFileFavorite = async (fileId: string, favorite: boolean) => {
  if (favorite) {
    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO file_favorites (file_id, created_at)
       VALUES (?, ?)
       ON CONFLICT(file_id) DO UPDATE SET created_at = excluded.created_at`
    ).run(fileId, now);
    return;
  }
  sqlite.prepare('DELETE FROM file_favorites WHERE file_id = ?').run(fileId);
};

export const findFileById = async (id: string, userId?: string) => {
  const row = (userId
    ? sqlite.prepare(
        `SELECT fi.*
         FROM files fi
         JOIN folders f ON f.id = fi.folder_id
         WHERE fi.id = ? AND f.user_id = ?`
      ).get(id, userId)
    : sqlite.prepare('SELECT * FROM files WHERE id = ?').get(id)) as FileRow | undefined;
  return row ? mapFileRow(row) : null;
};

export const findFileByPath = async (filePath: string, userId?: string) => {
  const row = (userId
    ? sqlite.prepare(
        `SELECT fi.*
         FROM files fi
         JOIN folders f ON f.id = fi.folder_id
         WHERE fi.path = ? AND f.user_id = ?`
      ).get(filePath, userId)
    : sqlite.prepare('SELECT * FROM files WHERE path = ?').get(filePath)) as FileRow | undefined;
  return row ? mapFileRow(row) : null;
};

export const deleteFile = async (id: string) => {
  const file = await findFileById(id);
  if (!file) return null;
  sqlite.prepare('DELETE FROM files WHERE id = ?').run(id);
  return file;
};
