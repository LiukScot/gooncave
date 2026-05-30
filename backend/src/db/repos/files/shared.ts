import type {
  FileRecord,
  FileTagRecord,
  FolderType,
  ProviderRunRecord,
  TagSource
} from '../../../db/types';
import type { MediaKind } from '../../../lib/scanner';
import { sqlite } from '../../client';

export type FileListSort = 'manual' | 'mtime_desc' | 'mtime_asc' | 'random';

export type FileListOptions = {
  folderId?: string;
  tagTerms?: string[];
  mediaType?: MediaKind;
  favoritesOnly?: boolean;
  sort?: FileListSort;
  seed?: string;
  limit?: number;
  offset?: number;
};

export type FileBatchCursor = {
  createdAt: string;
  id: string;
};

export type FileRow = {
  id: string;
  folder_id: string;
  location_type?: FolderType | null;
  path: string;
  size_bytes: number | string;
  mtime: string;
  sha256: string;
  phash?: string | null;
  media_type: MediaKind;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  thumb_path?: string | null;
  created_at: string;
  updated_at: string;
};

export type FileWithFavoriteRow = FileRow & {
  is_favorite?: number | boolean | null;
};

export type ProviderRunRow = {
  id: string;
  file_id: string;
  provider: ProviderRunRecord['provider'];
  status: ProviderRunRecord['status'];
  cached_hit?: number | boolean | null;
  score?: number | null;
  source_url?: string | null;
  thumb_url?: string | null;
  results?: string | null;
  created_at: string;
  completed_at?: string | null;
  error?: string | null;
};

export type FileTagRow = {
  file_id: string;
  tag: string;
  category: string;
  source: TagSource;
  score?: number | null;
  source_url?: string | null;
  created_at: string;
  updated_at: string;
};

const sqliteBusyRetryAttempts = 6;
const sqliteBusyRetryDelayMs = 250;

const parseResults = (value: string | null) => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isSqliteBusyError = (error: unknown) => {
  const message = (error as Error | undefined)?.message ?? '';
  return /database is locked|SQLITE_BUSY/i.test(message);
};

export const withSqliteRetry = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= sqliteBusyRetryAttempts) {
        throw error;
      }
      const delayMs = sqliteBusyRetryDelayMs * (attempt + 1);
      await sleep(delayMs);
      attempt += 1;
    }
  }
};

export const mapFileRow = (row: FileRow): FileRecord => ({
  id: row.id,
  folderId: row.folder_id,
  locationType: (row.location_type ?? 'LOCAL') as FolderType,
  path: row.path,
  sizeBytes: Number(row.size_bytes),
  mtime: row.mtime,
  sha256: row.sha256,
  phash: row.phash ?? null,
  mediaType: row.media_type as MediaKind,
  width: row.width ?? null,
  height: row.height ?? null,
  durationMs: row.duration_ms ?? null,
  thumbPath: row.thumb_path ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export const mapFileRowWithFavorite = (row: FileWithFavoriteRow): FileRecord => ({
  ...mapFileRow(row),
  isFavorite: Boolean(row.is_favorite)
});

export const mapProviderRunRow = (row: ProviderRunRow): ProviderRunRecord => ({
  id: row.id,
  fileId: row.file_id,
  provider: row.provider,
  status: row.status,
  cachedHit: Boolean(row.cached_hit),
  score: row.score === null || row.score === undefined ? null : Number(row.score),
  sourceUrl: row.source_url ?? null,
  thumbUrl: row.thumb_url ?? null,
  results: parseResults(row.results ?? null),
  createdAt: row.created_at,
  completedAt: row.completed_at ?? null,
  error: row.error ?? null
});

export const mapTagRow = (row: FileTagRow): FileTagRecord => ({
  fileId: row.file_id,
  tag: row.tag,
  category: row.category,
  source: row.source as TagSource,
  score: row.score ?? null,
  sourceUrl: row.source_url ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export const buildFileTagJoin = (tagTerms: string[]) => {
  if (tagTerms.length === 0) return { join: '', params: [] as unknown[] };
  const placeholders = tagTerms.map(() => '?').join(',');
  return {
    join: `JOIN (
        SELECT file_id
        FROM file_tags
        WHERE tag IN (${placeholders})
        GROUP BY file_id
        HAVING COUNT(DISTINCT tag) = ?
      ) tags ON tags.file_id = f.id`,
    params: [...tagTerms, tagTerms.length] as unknown[]
  };
};

export const buildFileWhereClause = (
  options: Pick<FileListOptions, 'folderId' | 'mediaType' | 'favoritesOnly'>,
  favoriteAlias = 'ff',
  userId?: string
) => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (userId) {
    where.push('f.folder_id IN (SELECT id FROM folders WHERE user_id = ?)');
    params.push(userId);
  }
  if (options.folderId) {
    where.push('f.folder_id = ?');
    params.push(options.folderId);
  }
  if (options.mediaType) {
    where.push('f.media_type = ?');
    params.push(options.mediaType);
  }
  if (options.favoritesOnly) {
    where.push(`${favoriteAlias}.file_id IS NOT NULL`);
  }
  return {
    clause: where.length ? ` WHERE ${where.join(' AND ')}` : '',
    params
  };
};

export const buildFileOrder = (sort?: FileListSort, seed?: string) => {
  switch (sort) {
    case 'manual':
      return {
        join: 'LEFT JOIN file_manual_order mo ON mo.file_id = f.id',
        clause:
          'CASE WHEN mo.position IS NULL THEN 0 ELSE 1 END ASC, CASE WHEN mo.position IS NULL THEN f.mtime END DESC, mo.position ASC, f.id ASC',
        params: [] as unknown[]
      };
    case 'mtime_desc':
      return { join: '', clause: 'f.mtime DESC, f.id DESC', params: [] as unknown[] };
    case 'mtime_asc':
      return { join: '', clause: 'f.mtime ASC, f.id ASC', params: [] as unknown[] };
    case 'random': {
      const normalizedSeed = seed?.trim();
      if (normalizedSeed) {
        return {
          join: '',
          clause: 'stable_hash(?, f.id) ASC, f.id ASC',
          params: [normalizedSeed] as unknown[]
        };
      }
      return { join: '', clause: 'RANDOM()', params: [] as unknown[] };
    }
    default:
      return { join: '', clause: 'f.created_at DESC, f.id DESC', params: [] as unknown[] };
  }
};

export const buildPaginationClause = (limit?: number, offset?: number) => {
  if (typeof limit === 'number') {
    if (typeof offset === 'number') {
      return { clause: ' LIMIT ? OFFSET ?', params: [limit, Math.max(0, offset)] as unknown[] };
    }
    return { clause: ' LIMIT ?', params: [limit] as unknown[] };
  }
  if (typeof offset === 'number') {
    return { clause: ' LIMIT -1 OFFSET ?', params: [Math.max(0, offset)] as unknown[] };
  }
  return { clause: '', params: [] as unknown[] };
};

export { sqlite };
