import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';

import Database from 'better-sqlite3';

import { config } from '../config';
import type { MediaKind, ScannedFile } from './scanner';

export type FolderStatus = 'IDLE' | 'SCANNING';
export type ScanStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

/** Stored in `folders.type` and used for `files.location_type` where applicable */
export type FolderType = 'LOCAL' | 'WEBDAV';

export type FolderRecord = {
  id: string;
  userId: string | null;
  path: string;
  type: FolderType;
  createdAt: string;
  updatedAt: string;
  lastScanAt: string | null;
  status: FolderStatus;
};

export type ScanRecord = {
  id: string;
  folderId: string;
  status: ScanStatus;
  progress: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FileRecord = {
  id: string;
  folderId: string;
  locationType: FolderType;
  path: string;
  sizeBytes: number;
  mtime: string;
  sha256: string;
  phash: string | null;
  mediaType: MediaKind;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbPath: string | null;
  isFavorite?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProviderRunRecord = {
  id: string;
  fileId: string;
  provider: 'SAUCENAO' | 'FLUFFLE';
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  cachedHit: boolean;
  score: number | null;
  sourceUrl: string | null;
  thumbUrl: string | null;
  results?: {
    sourceUrl: string | null;
    score: number | null;
    distance?: number | null;
    sourceName: string | null;
    thumbUrl: string | null;
  }[];
  createdAt: string;
  completedAt: string | null;
  error: string | null;
};

export type FavoriteProvider = 'E621' | 'DANBOORU';

export type FavoriteItemRecord = {
  provider: FavoriteProvider;
  remoteId: string;
  filePath: string;
  sourceUrl: string | null;
  fileUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CredentialProvider = 'E621' | 'DANBOORU' | 'SAUCENAO';

export type CredentialRecord = {
  provider: CredentialProvider;
  username: string | null;
  apiKey: string | null;
  updatedAt: string;
};

export type FavoritesSettings = {
  reverseSyncEnabled: boolean;
  autoSyncMidnight: boolean;
  favoritesRootId: string | null;
};

export type DuplicateSettings = {
  autoResolve: boolean;
};

export type UserRecord = {
  id: string;
  username: string;
  passwordHash: string;
  libraryRoot: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

export type SessionRecord = {
  id: string;
  userId: string;
  token: string;
  createdAt: string;
  expiresAt: string;
};

export type TagSource =
  | 'E621'
  | 'DANBOORU'
  | 'GELBOORU'
  | 'YANDERE'
  | 'KONACHAN'
  | 'SANKAKU'
  | 'IDOL_COMPLEX'
  | 'WD14'
  | 'MANUAL';

export type FileTagRecord = {
  fileId: string;
  tag: string;
  category: string;
  source: TagSource;
  score: number | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

type FileListSort = 'manual' | 'mtime_desc' | 'mtime_asc' | 'random';

type FileListOptions = {
  folderId?: string;
  tagTerms?: string[];
  mediaType?: MediaKind;
  favoritesOnly?: boolean;
  sort?: FileListSort;
  seed?: string;
  limit?: number;
  offset?: number;
};

type FileBatchCursor = {
  createdAt: string;
  id: string;
};
const dataFile = config.storage.dataFile ?? 'storage/data.db';
const dataDir = path.dirname(dataFile);

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dataFile);

db.function('stable_hash', { deterministic: true }, (seed: unknown, value: unknown) =>
  createHash('sha1').update(`${seed ?? ''}:${value ?? ''}`).digest('hex')
);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 30000');
db.pragma('cache_size = -4000');
db.pragma('mmap_size = 30000000');

const sqliteBusyRetryAttempts = 6;
const sqliteBusyRetryDelayMs = 250;

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    library_root TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    path TEXT NOT NULL,
    type TEXT NOT NULL,
    webdav_url TEXT,
    webdav_username TEXT,
    webdav_password TEXT,
    remote_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_scan_at TEXT,
    status TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    progress REAL NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    location_type TEXT NOT NULL,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    mtime TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    phash TEXT,
    media_type TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    thumb_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS provider_runs (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    cached_hit INTEGER NOT NULL,
    score REAL,
    source_url TEXT,
    thumb_url TEXT,
    results TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS file_tags (
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    category TEXT NOT NULL,
    source TEXT NOT NULL,
    score REAL,
    source_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (file_id, tag, source)
  );

  CREATE TABLE IF NOT EXISTS file_favorites (
    file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS favorite_items (
    user_id TEXT,
    provider TEXT NOT NULL,
    remote_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    source_url TEXT,
    file_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, provider, remote_id)
  );

  CREATE TABLE IF NOT EXISTS provider_credentials (
    user_id TEXT,
    provider TEXT NOT NULL,
    username TEXT,
    api_key TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, provider)
  );

  CREATE TABLE IF NOT EXISTS file_manual_order (
    file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    position REAL NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS file_signatures (
    file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    sample_size INTEGER NOT NULL,
    data BLOB NOT NULL,
    source_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_folders_path ON folders(path);
  CREATE INDEX IF NOT EXISTS idx_scans_folder_id ON scans(folder_id);
  CREATE INDEX IF NOT EXISTS idx_files_folder_id ON files(folder_id);
  CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
  CREATE INDEX IF NOT EXISTS idx_files_created_at_id ON files(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_files_mtime_id ON files(mtime DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_provider_runs_file_id ON provider_runs(file_id);
  CREATE INDEX IF NOT EXISTS idx_provider_runs_file_provider_created
    ON provider_runs(file_id, provider, completed_at DESC, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_file_tags_file_id ON file_tags(file_id);
  CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag);
  CREATE INDEX IF NOT EXISTS idx_file_tags_tag_file_id ON file_tags(tag, file_id);
  CREATE INDEX IF NOT EXISTS idx_file_favorites_file_id ON file_favorites(file_id);
  CREATE INDEX IF NOT EXISTS idx_file_favorites_created_at ON file_favorites(created_at);
  CREATE INDEX IF NOT EXISTS idx_favorite_items_provider ON favorite_items(provider);
  CREATE INDEX IF NOT EXISTS idx_favorite_items_file_path ON favorite_items(file_path);
  CREATE INDEX IF NOT EXISTS idx_provider_credentials_provider ON provider_credentials(provider);
  CREATE INDEX IF NOT EXISTS idx_file_manual_order_position ON file_manual_order(position);
  CREATE INDEX IF NOT EXISTS idx_file_signatures_sample_size_file_id ON file_signatures(sample_size, file_id);
  CREATE INDEX IF NOT EXISTS idx_files_media_type ON files(media_type);
  CREATE INDEX IF NOT EXISTS idx_provider_runs_provider_file_id ON provider_runs(provider, file_id);
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_user_settings_user_key ON user_settings(user_id, key);
`);

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

const withSqliteRetry = async <T>(operation: () => T | Promise<T>): Promise<T> => {
  let attempt = 0;
  while (true) {
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

const normalizeStoredPath = (value: string) => path.resolve(value);

const isSameOrInsideStoredPath = (candidatePath: string, basePath: string) => {
  const resolvedCandidate = normalizeStoredPath(candidatePath);
  const resolvedBase = normalizeStoredPath(basePath);
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
};

const replaceStoredPathPrefix = (filePath: string, sourceBasePath: string, targetBasePath: string) => {
  const resolvedFilePath = normalizeStoredPath(filePath);
  const resolvedSource = normalizeStoredPath(sourceBasePath);
  const resolvedTarget = normalizeStoredPath(targetBasePath);
  if (resolvedFilePath === resolvedSource) return resolvedTarget;
  if (!resolvedFilePath.startsWith(`${resolvedSource}${path.sep}`)) return resolvedFilePath;
  return path.resolve(resolvedTarget, path.relative(resolvedSource, resolvedFilePath));
};

const mapFolderRow = (row: any): FolderRecord => ({
  id: row.id,
  userId: row.user_id ?? null,
  path: row.path,
  type: (row.type ?? 'LOCAL') as FolderType,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastScanAt: row.last_scan_at ?? null,
  status: row.status as FolderStatus
});

const mapScanRow = (row: any): ScanRecord => ({
  id: row.id,
  folderId: row.folder_id,
  status: row.status as ScanStatus,
  progress: Number(row.progress ?? 0),
  error: row.error ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapFileRow = (row: any): FileRecord => ({
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

const mapFileRowWithFavorite = (row: any): FileRecord => ({
  ...mapFileRow(row),
  isFavorite: Boolean(row.is_favorite)
});

const mapProviderRunRow = (row: any): ProviderRunRecord => ({
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

const mapTagRow = (row: any): FileTagRecord => ({
  fileId: row.file_id,
  tag: row.tag,
  category: row.category,
  source: row.source as TagSource,
  score: row.score ?? null,
  sourceUrl: row.source_url ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const buildFileTagJoin = (tagTerms: string[]) => {
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

const buildFileWhereClause = (
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

const buildFileOrder = (sort?: FileListSort, seed?: string) => {
  switch (sort) {
    case 'manual':
      return {
        join: 'LEFT JOIN file_manual_order mo ON mo.file_id = f.id',
        clause:
          'CASE WHEN mo.position IS NULL THEN 0 ELSE 1 END ASC, CASE WHEN mo.position IS NULL THEN f.mtime END DESC, mo.position ASC, f.id ASC',
        params: [] as unknown[]
      };
    case 'mtime_desc':
      return {
        join: '',
        clause: 'f.mtime DESC, f.id DESC',
        params: [] as unknown[]
      };
    case 'mtime_asc':
      return {
        join: '',
        clause: 'f.mtime ASC, f.id ASC',
        params: [] as unknown[]
      };
    case 'random': {
      const normalizedSeed = seed?.trim();
      if (normalizedSeed) {
        return {
          join: '',
          clause: 'stable_hash(?, f.id) ASC, f.id ASC',
          params: [normalizedSeed] as unknown[]
        };
      }
      return {
        join: '',
        clause: 'RANDOM()',
        params: [] as unknown[]
      };
    }
    default:
      return {
        join: '',
        clause: 'f.created_at DESC, f.id DESC',
        params: [] as unknown[]
      };
  }
};

const buildPaginationClause = (limit?: number, offset?: number) => {
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

const mapCredentialRow = (row: any): CredentialRecord => ({
  provider: row.provider as CredentialProvider,
  username: row.username ?? null,
  apiKey: row.api_key ?? null,
  updatedAt: row.updated_at
});

const mapFavoriteRow = (row: any): FavoriteItemRecord => ({
  provider: row.provider as FavoriteProvider,
  remoteId: row.remote_id,
  filePath: row.file_path,
  sourceUrl: row.source_url ?? null,
  fileUrl: row.file_url ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapUserRow = (row: any): UserRecord => ({
  id: row.id,
  username: row.username,
  passwordHash: row.password_hash,
  libraryRoot: row.library_root,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastLoginAt: row.last_login_at ?? null
});

const mapSessionRow = (row: any): SessionRecord => ({
  id: row.id,
  userId: row.user_id,
  token: row.token,
  createdAt: row.created_at,
  expiresAt: row.expires_at
});

const getMeta = (key: string) => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
};

const setMeta = (key: string, value: string) => {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
};

const deleteMeta = (key: string) => {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key);
};

const normalizeKeyList = (value: string[] | undefined) => {
  if (!Array.isArray(value)) return [];
  const cleaned = value
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(cleaned));
};

const getUserSetting = (userId: string, key: string) => {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
};

const setUserSetting = (userId: string, key: string, value: string) => {
  db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(userId, key, value);
};

const deleteUserSetting = (userId: string, key: string) => {
  db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key);
};

const readUserSettingJson = <T>(userId: string, key: string, fallback: T): T => {
  const raw = getUserSetting(userId, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const readUserSettingBool = (userId: string, key: string, fallback: boolean) => {
  const raw = getUserSetting(userId, key);
  if (raw === null) return fallback;
  return raw === 'true';
};

const readUserSettingString = (userId: string, key: string) => {
  const raw = getUserSetting(userId, key);
  if (!raw) return null;
  const cleaned = raw.trim();
  return cleaned.length > 0 ? cleaned : null;
};

const writeUserSettingJson = (userId: string, key: string, value: unknown) => {
  setUserSetting(userId, key, JSON.stringify(value));
};

const purgeProviderRunsIfNeeded = () => {
  const purgeKey = 'purged_provider_runs_v1';
  if (getMeta(purgeKey)) return;
  const providers: ProviderRunRecord['provider'][] = ['SAUCENAO', 'FLUFFLE'];
  const placeholders = providers.map(() => '?').join(',');
  const result = db
    .prepare(`DELETE FROM provider_runs WHERE provider IN (${placeholders})`)
    .run(...providers);
  setMeta(purgeKey, new Date().toISOString());
  if (result.changes > 0) {
    console.log(`[storage] purged ${result.changes} provider runs for ${providers.join(', ')}`);
  }
};

const purgeFileTagsIfNeeded = () => {
  const purgeKey = 'purged_file_tags_v1';
  if (getMeta(purgeKey)) return;
  const result = db.prepare('DELETE FROM file_tags').run();
  setMeta(purgeKey, new Date().toISOString());
  if (result.changes > 0) {
    console.log(`[storage] purged ${result.changes} file tags`);
  }
};

purgeProviderRunsIfNeeded();
purgeFileTagsIfNeeded();

export const dataStore = {
  async countUsers() {
    const row = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  },
  async listUsers() {
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as any[];
    return rows.map(mapUserRow);
  },
  async findUserById(id: string) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any | undefined;
    return row ? mapUserRow(row) : null;
  },
  async findUserByUsername(username: string) {
    const row = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username) as any | undefined;
    return row ? mapUserRow(row) : null;
  },
  async findUserByFolderId(folderId: string) {
    const row = db
      .prepare(
        `SELECT u.*
         FROM users u
         JOIN folders f ON f.user_id = u.id
         WHERE f.id = ?`
      )
      .get(folderId) as any | undefined;
    return row ? mapUserRow(row) : null;
  },
  async findUserByFileId(fileId: string) {
    const row = db
      .prepare(
        `SELECT u.*
         FROM users u
         JOIN folders f ON f.user_id = u.id
         JOIN files fi ON fi.folder_id = f.id
         WHERE fi.id = ?`
      )
      .get(fileId) as any | undefined;
    return row ? mapUserRow(row) : null;
  },
  async createUser(input: { id?: string; username: string; passwordHash: string; libraryRoot: string }) {
    const now = new Date().toISOString();
    const user: UserRecord = {
      id: input.id ?? randomUUID(),
      username: input.username,
      passwordHash: input.passwordHash,
      libraryRoot: input.libraryRoot,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null
    };
    db.prepare(
      `INSERT INTO users (id, username, password_hash, library_root, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(user.id, user.username, user.passwordHash, user.libraryRoot, user.createdAt, user.updatedAt, user.lastLoginAt);
    return user;
  },
  async setUserLibraryRoot(userId: string, libraryRoot: string) {
    const now = new Date().toISOString();
    db.prepare('UPDATE users SET library_root = ?, updated_at = ? WHERE id = ?').run(libraryRoot, now, userId);
  },
  async updateUserLastLogin(userId: string) {
    const now = new Date().toISOString();
    db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, userId);
  },
  async createSession(userId: string, token: string, expiresAt: string) {
    const session: SessionRecord = {
      id: randomUUID(),
      userId,
      token,
      createdAt: new Date().toISOString(),
      expiresAt
    };
    db.prepare(
      `INSERT INTO sessions (id, user_id, token, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(session.id, session.userId, session.token, session.createdAt, session.expiresAt);
    return session;
  },
  async findSessionByToken(token: string) {
    const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as any | undefined;
    return row ? mapSessionRow(row) : null;
  },
  async deleteSessionByToken(token: string) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  },
  async deleteExpiredSessions() {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  },
  async listFilesPage(options: FileListOptions = {}, userId?: string) {
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
    const countRow = db
      .prepare(countSql)
      .get(...tagJoin.params, ...countWhere.params) as { total?: number } | undefined;
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
    const rows = db
      .prepare(pageSql)
      .all(...tagJoin.params, ...pageWhere.params, ...order.params, ...pagination.params);
    return {
      files: rows.map(mapFileRowWithFavorite),
      total
    };
  },
  async listFilesWithProviderRuns(folderId?: string, tagTerms?: string[], userId?: string) {
    const normalizedTerms = (tagTerms ?? []).map((term) => term.trim()).filter(Boolean);
    let files: any[];

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
      const params = [
        ...(folderId ? [folderId] : []),
        ...(userId ? [userId] : []),
        ...normalizedTerms,
        normalizedTerms.length
      ];
      files = db.prepare(sql).all(...params);
    } else {
      if (folderId && userId) {
        files = db
          .prepare(
            `SELECT * FROM files WHERE folder_id = ? AND folder_id IN (SELECT id FROM folders WHERE user_id = ?) ORDER BY created_at DESC`
          )
          .all(folderId, userId);
      } else if (folderId) {
        files = db.prepare('SELECT * FROM files WHERE folder_id = ? ORDER BY created_at DESC').all(folderId);
      } else if (userId) {
        files = db
          .prepare(`SELECT * FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?) ORDER BY created_at DESC`)
          .all(userId);
      } else {
        files = db.prepare('SELECT * FROM files ORDER BY created_at DESC').all();
      }
    }
    const fileRecords = files.map(mapFileRow);
    const providerRunsByFile: Record<string, ProviderRunRecord[]> = {};
    let favoriteIds = new Set<string>();

    if (fileRecords.length) {
      const ids = fileRecords.map((file) => file.id);
      favoriteIds = await this.listFavoriteFileIds(ids);
      const placeholders = ids.map(() => '?').join(',');
      const runs = db
        .prepare(`SELECT * FROM provider_runs WHERE file_id IN (${placeholders})`)
        .all(...ids)
        .map(mapProviderRunRow);

      for (const run of runs) {
        if (!providerRunsByFile[run.fileId]) providerRunsByFile[run.fileId] = [];
        providerRunsByFile[run.fileId].push(run);
      }
    }

    const filesWithFavorites = fileRecords.map((file) => ({
      ...file,
      isFavorite: favoriteIds.has(file.id)
    }));
    return { files: filesWithFavorites, providerRunsByFile };
  },
  async ensureFolders(folderPaths: string[], userId?: string) {
    if (folderPaths.length === 0) return [];
    const now = new Date().toISOString();
    const ensured: FolderRecord[] = [];

    const selectByPath = userId
      ? db.prepare('SELECT * FROM folders WHERE path = ? AND user_id = ?')
      : db.prepare('SELECT * FROM folders WHERE path = ?');
    const insertFolder = userId
      ? db.prepare(
          `INSERT INTO folders (id, user_id, path, type, created_at, updated_at, last_scan_at, status)
           VALUES (?, ?, ?, 'LOCAL', ?, ?, ?, ?)`
        )
      : db.prepare(
          `INSERT INTO folders (id, path, type, created_at, updated_at, last_scan_at, status)
           VALUES (?, ?, 'LOCAL', ?, ?, ?, ?)`
        );

    for (const folderPath of folderPaths) {
      await fs.promises.mkdir(folderPath, { recursive: true });
    }

    const tx = db.transaction(() => {
      for (const folderPath of folderPaths) {
        const existing = (userId ? selectByPath.get(folderPath, userId) : selectByPath.get(folderPath)) as any | undefined;
        if (!existing) {
          const folder: FolderRecord = {
            id: randomUUID(),
            userId: userId ?? null,
            path: folderPath,
            type: 'LOCAL',
            createdAt: now,
            updatedAt: now,
            lastScanAt: null,
            status: 'IDLE'
          };
          if (userId) {
            insertFolder.run(
              folder.id,
              folder.userId,
              folder.path,
              folder.createdAt,
              folder.updatedAt,
              folder.lastScanAt,
              folder.status
            );
          } else {
            insertFolder.run(
              folder.id,
              folder.path,
              folder.createdAt,
              folder.updatedAt,
              folder.lastScanAt,
              folder.status
            );
          }
          ensured.push(folder);
        } else {
          ensured.push(mapFolderRow(existing));
        }
      }
    });

    tx();
    return ensured;
  },
  async listFolders(userId?: string) {
    const rows = userId
      ? db.prepare('SELECT * FROM folders WHERE user_id = ? ORDER BY created_at DESC').all(userId)
      : db.prepare('SELECT * FROM folders ORDER BY created_at DESC').all();
    return rows.map(mapFolderRow);
  },
  async findFolderById(id: string, userId?: string) {
    const row = (userId
      ? db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').get(id, userId)
      : db.prepare('SELECT * FROM folders WHERE id = ?').get(id)) as any | undefined;
    return row ? mapFolderRow(row) : null;
  },
  async findFolderByPath(folderPath: string, userId?: string) {
    const row = (userId
      ? db.prepare('SELECT * FROM folders WHERE path = ? AND user_id = ?').get(folderPath, userId)
      : db.prepare('SELECT * FROM folders WHERE path = ?').get(folderPath)) as any | undefined;
    return row ? mapFolderRow(row) : null;
  },
  async addFolder(folderPath: string, userId?: string) {
    const now = new Date().toISOString();
    await fs.promises.mkdir(folderPath, { recursive: true });
    const folder: FolderRecord = {
      id: randomUUID(),
      userId: userId ?? null,
      path: folderPath,
      type: 'LOCAL',
      createdAt: now,
      updatedAt: now,
      lastScanAt: null,
      status: 'IDLE'
    };
    if (userId) {
      db.prepare(
        `INSERT INTO folders (id, user_id, path, type, created_at, updated_at, last_scan_at, status)
         VALUES (?, ?, ?, 'LOCAL', ?, ?, ?, ?)`
      ).run(folder.id, folder.userId, folder.path, folder.createdAt, folder.updatedAt, folder.lastScanAt, folder.status);
    } else {
      db.prepare(
        `INSERT INTO folders (id, path, type, created_at, updated_at, last_scan_at, status)
         VALUES (?, ?, 'LOCAL', ?, ?, ?, ?)`
      ).run(folder.id, folder.path, folder.createdAt, folder.updatedAt, folder.lastScanAt, folder.status);
    }
    return folder;
  },
  async updateFolder(id: string, updates: Partial<Omit<FolderRecord, 'id'>>, userId?: string) {
    const existing = await this.findFolderById(id, userId);
    if (!existing) return null;
    const now = new Date().toISOString();
    const folder: FolderRecord = {
      ...existing,
      ...updates,
      updatedAt: now
    };
    await fs.promises.mkdir(folder.path, { recursive: true });
    db.prepare(
      `UPDATE folders SET user_id = ?, path = ?, created_at = ?, updated_at = ?, last_scan_at = ?, status = ? WHERE id = ?`
    ).run(
      folder.userId,
      folder.path,
      folder.createdAt,
      folder.updatedAt,
      folder.lastScanAt,
      folder.status,
      folder.id
    );
    return folder;
  },
  async deleteFolder(id: string, userId?: string) {
    if (userId) {
      const favoritesRootId = readUserSettingString(userId, 'favorites_root_id');
      if (favoritesRootId === id) {
        deleteUserSetting(userId, 'favorites_root_id');
      }
      db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(id, userId);
      return { status: 'deleted' };
    }

    console.warn('[dataStore.deleteFolder] Calling deleteFolder without userId is deprecated. Pass userId to ensure user-scoped deletion.');
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    return { status: 'deleted' };
  },
  async deleteFilesInFolderByPrefixes(folderId: string, prefixes: string[], userId?: string) {
    const folder = await this.findFolderById(folderId, userId);
    if (!folder) return 0;

    const normalizedPrefixes = prefixes.map((prefix) => normalizeStoredPath(prefix));
    if (normalizedPrefixes.length === 0) return 0;

    const rows = db.prepare('SELECT id, path FROM files WHERE folder_id = ?').all(folderId) as { id: string; path: string }[];
    const idsToDelete = rows
      .filter((row) => normalizedPrefixes.some((prefix) => isSameOrInsideStoredPath(row.path, prefix)))
      .map((row) => row.id);

    if (idsToDelete.length === 0) return 0;

    const tx = db.transaction(() => {
      for (const fileId of idsToDelete) {
        db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
      }
    });

    tx();
    return idsToDelete.length;
  },
  async listScans(userId?: string) {
    const rows = userId
      ? db
          .prepare(
            `SELECT s.*
             FROM scans s
             JOIN folders f ON f.id = s.folder_id
             WHERE f.user_id = ?
             ORDER BY s.created_at DESC`
          )
          .all(userId)
      : db.prepare('SELECT * FROM scans ORDER BY created_at DESC').all();
    return rows.map(mapScanRow);
  },
  async findScanById(id: string, userId?: string) {
    const row = (userId
      ? db
          .prepare(
            `SELECT s.*
             FROM scans s
             JOIN folders f ON f.id = s.folder_id
             WHERE s.id = ? AND f.user_id = ?`
          )
          .get(id, userId)
      : db.prepare('SELECT * FROM scans WHERE id = ?').get(id)) as any | undefined;
    return row ? mapScanRow(row) : null;
  },
  async createScan(folderId: string) {
    const now = new Date().toISOString();
    const scan: ScanRecord = {
      id: randomUUID(),
      folderId,
      status: 'PENDING',
      progress: 0,
      error: null,
      createdAt: now,
      updatedAt: now
    };
    db.prepare(
      `INSERT INTO scans (id, folder_id, status, progress, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(scan.id, scan.folderId, scan.status, scan.progress, scan.error, scan.createdAt, scan.updatedAt);
    return scan;
  },
  async updateScan(id: string, updates: Partial<Omit<ScanRecord, 'id' | 'folderId'>>) {
    const existing = await this.findScanById(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const scan: ScanRecord = {
      ...existing,
      ...updates,
      updatedAt: now
    };
    db.prepare(
      `UPDATE scans SET status = ?, progress = ?, error = ?, created_at = ?, updated_at = ? WHERE id = ?`
    ).run(scan.status, scan.progress, scan.error, scan.createdAt, scan.updatedAt, scan.id);
    return scan;
  },
  async clearPendingAndRunning(userId?: string) {
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      if (userId) {
        db.prepare(
          `UPDATE scans
           SET status = 'FAILED', error = 'Cleared by user', updated_at = ?
           WHERE status IN ('PENDING', 'RUNNING')
             AND folder_id IN (SELECT id FROM folders WHERE user_id = ?)`
        ).run(now, userId);
        db.prepare(`UPDATE folders SET status = 'IDLE', updated_at = ? WHERE status = 'SCANNING' AND user_id = ?`).run(
          now,
          userId
        );
      } else {
        db.prepare(
          `UPDATE scans SET status = 'FAILED', error = 'Cleared by user', updated_at = ? WHERE status IN ('PENDING', 'RUNNING')`
        ).run(now);
        db.prepare(`UPDATE folders SET status = 'IDLE', updated_at = ? WHERE status = 'SCANNING'`).run(now);
      }
    });
    tx();
  },
  async stopScan(scanId: string) {
    const scan = await this.findScanById(scanId);
    if (!scan) return null;
    const folder = await this.findFolderById(scan.folderId);
    if (scan.status === 'COMPLETED' || scan.status === 'FAILED') {
      return { scan, folder };
    }
    const now = new Date().toISOString();
    const updatedScan: ScanRecord = {
      ...scan,
      status: 'FAILED',
      error: 'Stopped by user',
      progress: 0,
      updatedAt: now
    };
    db.prepare(`UPDATE scans SET status = ?, error = ?, progress = ?, updated_at = ? WHERE id = ?`).run(
      updatedScan.status,
      updatedScan.error,
      updatedScan.progress,
      updatedScan.updatedAt,
      updatedScan.id
    );

    let updatedFolder = folder;
    if (folder) {
      updatedFolder = {
        ...folder,
        status: 'IDLE',
        updatedAt: now
      };
      db.prepare(`UPDATE folders SET status = ?, updated_at = ? WHERE id = ?`).run(
        updatedFolder.status,
        updatedFolder.updatedAt,
        updatedFolder.id
      );
    }

    return { scan: updatedScan, folder: updatedFolder };
  },
  async upsertFile(folderId: string, file: ScannedFile) {
    const existingRow = db
      .prepare('SELECT * FROM files WHERE folder_id = ? AND path = ?')
      .get(folderId, file.path) as any | undefined;
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
      db.prepare(
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
    db.prepare(
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
  },
  async listFiles(folderId?: string, userId?: string) {
    let rows: any[];
    if (folderId && userId) {
      rows = db
        .prepare(
          `SELECT * FROM files WHERE folder_id = ? AND folder_id IN (SELECT id FROM folders WHERE user_id = ?) ORDER BY created_at DESC`
        )
        .all(folderId, userId);
    } else if (folderId) {
      rows = db.prepare('SELECT * FROM files WHERE folder_id = ? ORDER BY created_at DESC').all(folderId);
    } else if (userId) {
      rows = db
        .prepare(`SELECT * FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?) ORDER BY created_at DESC`)
        .all(userId);
    } else {
      rows = db.prepare('SELECT * FROM files ORDER BY created_at DESC').all();
    }
    return rows.map(mapFileRow);
  },
  async listFilesBatch(options?: { limit?: number; after?: FileBatchCursor | null; mediaType?: MediaKind }, userId?: string) {
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
    const rows = db
      .prepare(`SELECT * FROM files${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params, limit);
    const files = rows.map(mapFileRow);
    const last = files[files.length - 1];
    return {
      files,
      nextCursor:
        files.length === limit && last
          ? ({
              createdAt: last.createdAt,
              id: last.id
            } as FileBatchCursor)
          : null
    };
  },
  listFilesWithoutProviderRun(provider: string, limit = 100, userId?: string): FileRecord[] {
    const rows = userId
      ? db
          .prepare(
            `SELECT * FROM files
             WHERE id NOT IN (SELECT DISTINCT file_id FROM provider_runs WHERE provider = ?)
               AND folder_id IN (SELECT id FROM folders WHERE user_id = ?)
             ORDER BY RANDOM()
             LIMIT ?`
          )
          .all(provider, userId, limit)
      : db
          .prepare(
            `SELECT * FROM files
             WHERE id NOT IN (SELECT DISTINCT file_id FROM provider_runs WHERE provider = ?)
             ORDER BY RANDOM()
             LIMIT ?`
          )
          .all(provider, limit);
    return rows.map(mapFileRow);
  },
  async listFavoriteFileIds(fileIds: string[]) {
    if (fileIds.length === 0) return new Set<string>();
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT file_id FROM file_favorites WHERE file_id IN (${placeholders})`)
      .all(...fileIds) as { file_id: string }[];
    return new Set(rows.map((row) => row.file_id));
  },
  async setFileFavorite(fileId: string, favorite: boolean) {
    if (favorite) {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO file_favorites (file_id, created_at)
         VALUES (?, ?)
         ON CONFLICT(file_id) DO UPDATE SET created_at = excluded.created_at`
      ).run(fileId, now);
    } else {
      db.prepare('DELETE FROM file_favorites WHERE file_id = ?').run(fileId);
    }
  },
  async findFileById(id: string, userId?: string) {
    const row = (userId
      ? db
          .prepare(
            `SELECT fi.*
             FROM files fi
             JOIN folders f ON f.id = fi.folder_id
             WHERE fi.id = ? AND f.user_id = ?`
          )
          .get(id, userId)
      : db.prepare('SELECT * FROM files WHERE id = ?').get(id)) as any | undefined;
    return row ? mapFileRow(row) : null;
  },
  async findFileByPath(filePath: string, userId?: string) {
    const row = (userId
      ? db
          .prepare(
            `SELECT fi.*
             FROM files fi
             JOIN folders f ON f.id = fi.folder_id
             WHERE fi.path = ? AND f.user_id = ?`
          )
          .get(filePath, userId)
      : db.prepare('SELECT * FROM files WHERE path = ?').get(filePath)) as any | undefined;
    return row ? mapFileRow(row) : null;
  },
  async deleteFile(id: string) {
    const file = await this.findFileById(id);
    if (!file) return null;
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
    return file;
  },
  async listProviderRuns(fileId: string) {
    const rows = db
      .prepare('SELECT * FROM provider_runs WHERE file_id = ? ORDER BY COALESCE(completed_at, created_at) DESC')
      .all(fileId);
    return rows.map(mapProviderRunRow);
  },
  async listProviderRunsByFileIds(fileIds: string[]) {
    const grouped: Record<string, ProviderRunRecord[]> = {};
    if (fileIds.length === 0) return grouped;
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT * FROM provider_runs
         WHERE file_id IN (${placeholders})
         ORDER BY file_id ASC, COALESCE(completed_at, created_at) DESC`
      )
      .all(...fileIds);
    for (const row of rows) {
      const run = mapProviderRunRow(row);
      if (!grouped[run.fileId]) grouped[run.fileId] = [];
      grouped[run.fileId].push(run);
    }
    return grouped;
  },
  async createProviderRunWithLimit(
    fileId: string,
    provider: 'SAUCENAO' | 'FLUFFLE',
    limit: number,
    windowMs: number
  ) {
    const now = new Date();
    const createdAt = now.toISOString();
    const windowStart = new Date(now.getTime() - windowMs).toISOString();
    const insertProviderRun = db.prepare(
      `INSERT INTO provider_runs (id, file_id, provider, status, cached_hit, score, source_url, thumb_url, results, created_at, completed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      const countRow = db
        .prepare('SELECT COUNT(1) AS count FROM provider_runs WHERE provider = ? AND created_at >= ? AND cached_hit = 0')
        .get(provider, windowStart) as { count?: number } | undefined;
      const count = Number(countRow?.count ?? 0);
      if (count >= limit) {
        const oldestRow = db
          .prepare(
            'SELECT created_at FROM provider_runs WHERE provider = ? AND created_at >= ? AND cached_hit = 0 ORDER BY created_at ASC LIMIT 1'
          )
          .get(provider, windowStart) as { created_at?: string } | undefined;
        const oldest = oldestRow?.created_at ? new Date(oldestRow.created_at) : null;
        const retryAt = oldest ? new Date(oldest.getTime() + windowMs).toISOString() : null;
        return { run: null, rateLimited: true, retryAt, count };
      }

      const run: ProviderRunRecord = {
        id: randomUUID(),
        fileId,
        provider,
        status: 'PENDING',
        cachedHit: false,
        score: null,
        sourceUrl: null,
        thumbUrl: null,
        results: [],
        createdAt,
        completedAt: null,
        error: null
      };
      insertProviderRun.run(
        run.id,
        run.fileId,
        run.provider,
        run.status,
        run.cachedHit ? 1 : 0,
        run.score,
        run.sourceUrl,
        run.thumbUrl,
        JSON.stringify(run.results ?? []),
        run.createdAt,
        run.completedAt,
        run.error
      );
      return { run, rateLimited: false, retryAt: null, count: count + 1 };
    });
    return withSqliteRetry(() => tx());
  },
  async createProviderRun(fileId: string, provider: 'SAUCENAO' | 'FLUFFLE') {
    const now = new Date().toISOString();
    const run: ProviderRunRecord = {
      id: randomUUID(),
      fileId,
      provider,
      status: 'PENDING',
      cachedHit: false,
      score: null,
      sourceUrl: null,
      thumbUrl: null,
      results: [],
      createdAt: now,
      completedAt: null,
      error: null
    };
    await withSqliteRetry(() => {
      db.prepare(
        `INSERT INTO provider_runs (id, file_id, provider, status, cached_hit, score, source_url, thumb_url, results, created_at, completed_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        run.id,
        run.fileId,
        run.provider,
        run.status,
        run.cachedHit ? 1 : 0,
        run.score,
        run.sourceUrl,
        run.thumbUrl,
        JSON.stringify(run.results ?? []),
        run.createdAt,
        run.completedAt,
        run.error
      );
    });
    return run;
  },
  async updateProviderRun(id: string, updates: Partial<Omit<ProviderRunRecord, 'id' | 'fileId'>>) {
    return withSqliteRetry(() => {
      const existingRow = db.prepare('SELECT * FROM provider_runs WHERE id = ?').get(id) as any | undefined;
      if (!existingRow) return null;
      const existing = mapProviderRunRow(existingRow);
      const run: ProviderRunRecord = {
        ...existing,
        ...updates
      };
      db.prepare(
        `UPDATE provider_runs SET provider = ?, status = ?, cached_hit = ?, score = ?, source_url = ?, thumb_url = ?, results = ?, created_at = ?, completed_at = ?, error = ? WHERE id = ?`
      ).run(
        run.provider,
        run.status,
        run.cachedHit ? 1 : 0,
        run.score,
        run.sourceUrl,
        run.thumbUrl,
        JSON.stringify(run.results ?? []),
        run.createdAt,
        run.completedAt,
        run.error,
        run.id
      );
      return run;
    });
  },
  async listAllProviderRuns() {
    const rows = db.prepare('SELECT * FROM provider_runs ORDER BY created_at DESC').all();
    return rows.map(mapProviderRunRow);
  },
  async listManualOrderPositions(fileIds: string[]) {
    if (fileIds.length === 0) return {};
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT file_id, position FROM file_manual_order WHERE file_id IN (${placeholders})`)
      .all(...fileIds) as { file_id: string; position: number }[];
    const positions: Record<string, number> = {};
    for (const row of rows) {
      positions[row.file_id] = row.position;
    }
    return positions;
  },
  async listTagsForFile(fileId: string) {
    const rows = db.prepare('SELECT * FROM file_tags WHERE file_id = ? ORDER BY tag ASC').all(fileId);
    return rows.map(mapTagRow);
  },
  async getCredential(provider: CredentialProvider, userId: string) {
    const row = db.prepare('SELECT * FROM provider_credentials WHERE provider = ? AND user_id = ?').get(provider, userId) as
      | any
      | undefined;
    return row ? mapCredentialRow(row) : null;
  },
  async listCredentials(userId: string) {
    const rows = db.prepare('SELECT * FROM provider_credentials WHERE user_id = ?').all(userId) as any[];
    return rows.map(mapCredentialRow);
  },
  async upsertCredential(provider: CredentialProvider, updates: { username?: string; apiKey?: string }, userId: string) {
    const existingRow = db.prepare('SELECT * FROM provider_credentials WHERE provider = ? AND user_id = ?').get(provider, userId) as
      | any
      | undefined;
    const existing = existingRow ? mapCredentialRow(existingRow) : null;
    const nextUsername =
      provider === 'SAUCENAO'
        ? null
        : updates.username !== undefined
          ? updates.username.trim() || null
          : existing?.username ?? null;
    const nextApiKey =
      updates.apiKey !== undefined ? updates.apiKey.trim() || null : existing?.apiKey ?? null;
    if ((!nextUsername && provider !== 'SAUCENAO') && !nextApiKey) {
      db.prepare('DELETE FROM provider_credentials WHERE provider = ? AND user_id = ?').run(provider, userId);
      return null;
    }
    if (provider === 'SAUCENAO' && !nextApiKey) {
      db.prepare('DELETE FROM provider_credentials WHERE provider = ? AND user_id = ?').run(provider, userId);
      return null;
    }
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO provider_credentials (user_id, provider, username, api_key, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, provider)
       DO UPDATE SET username = excluded.username, api_key = excluded.api_key, updated_at = excluded.updated_at`
    ).run(userId, provider, nextUsername, nextApiKey, now);
    return {
      provider,
      username: nextUsername,
      apiKey: nextApiKey,
      updatedAt: now
    } as CredentialRecord;
  },
  async listFavoriteItems(provider: FavoriteProvider | undefined, userId: string) {
    let rows: any[];
    if (provider) {
      rows = db.prepare('SELECT * FROM favorite_items WHERE provider = ? AND user_id = ? ORDER BY updated_at DESC').all(provider, userId);
    } else {
      rows = db.prepare('SELECT * FROM favorite_items WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
    }
    return rows.map(mapFavoriteRow);
  },
  async findFavoriteItemByPath(filePath: string, userId: string) {
    const row = db.prepare('SELECT * FROM favorite_items WHERE file_path = ? AND user_id = ?').get(filePath, userId) as any | undefined;
    return row ? mapFavoriteRow(row) : null;
  },
  async upsertFavoriteItem(item: {
    provider: FavoriteProvider;
    remoteId: string;
    filePath: string;
    sourceUrl?: string | null;
    fileUrl?: string | null;
  }, userId: string) {
    const now = new Date().toISOString();
    const existing = db
      .prepare('SELECT * FROM favorite_items WHERE provider = ? AND remote_id = ? AND user_id = ?')
      .get(item.provider, item.remoteId, userId) as any | undefined;
    if (existing) {
      db.prepare(
        `UPDATE favorite_items
         SET file_path = ?, source_url = ?, file_url = ?, updated_at = ?
         WHERE provider = ? AND remote_id = ? AND user_id = ?`
      ).run(item.filePath, item.sourceUrl ?? null, item.fileUrl ?? null, now, item.provider, item.remoteId, userId);
      return {
        ...mapFavoriteRow(existing),
        filePath: item.filePath,
        sourceUrl: item.sourceUrl ?? null,
        fileUrl: item.fileUrl ?? null,
        updatedAt: now
      };
    }
    db.prepare(
      `INSERT INTO favorite_items (user_id, provider, remote_id, file_path, source_url, file_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      item.provider,
      item.remoteId,
      item.filePath,
      item.sourceUrl ?? null,
      item.fileUrl ?? null,
      now,
      now
    );
    return {
      provider: item.provider,
      remoteId: item.remoteId,
      filePath: item.filePath,
      sourceUrl: item.sourceUrl ?? null,
      fileUrl: item.fileUrl ?? null,
      createdAt: now,
      updatedAt: now
    } as FavoriteItemRecord;
  },
  async deleteFavoriteItem(provider: FavoriteProvider, remoteId: string, userId: string) {
    db.prepare('DELETE FROM favorite_items WHERE provider = ? AND remote_id = ? AND user_id = ?').run(provider, remoteId, userId);
  },
  async getFavoritesSettings(userId: string): Promise<FavoritesSettings> {
    const autoSyncDefault = config.favorites.syncIntervalMs > 0;
    const favoritesRootId = readUserSettingString(userId, 'favorites_root_id');
    return {
      reverseSyncEnabled: readUserSettingBool(userId, 'favorites_reverse_sync', false),
      autoSyncMidnight: readUserSettingBool(userId, 'favorites_auto_sync_midnight', autoSyncDefault),
      favoritesRootId
    };
  },
  async saveFavoritesSettings(input: Partial<FavoritesSettings>, userId: string): Promise<FavoritesSettings> {
    const current = await this.getFavoritesSettings(userId);
    const reverseSyncEnabled =
      input.reverseSyncEnabled !== undefined ? input.reverseSyncEnabled : current.reverseSyncEnabled;
    const autoSyncMidnight =
      input.autoSyncMidnight !== undefined ? input.autoSyncMidnight : current.autoSyncMidnight;
    const favoritesRootId =
      input.favoritesRootId !== undefined ? input.favoritesRootId : current.favoritesRootId;
    setUserSetting(userId, 'favorites_reverse_sync', reverseSyncEnabled ? 'true' : 'false');
    setUserSetting(userId, 'favorites_auto_sync_midnight', autoSyncMidnight ? 'true' : 'false');
    if (favoritesRootId) {
      setUserSetting(userId, 'favorites_root_id', favoritesRootId);
    } else {
      deleteUserSetting(userId, 'favorites_root_id');
    }
    return { reverseSyncEnabled, autoSyncMidnight, favoritesRootId: favoritesRootId ?? null };
  },
  async getDuplicateSettings(userId: string): Promise<DuplicateSettings> {
    return {
      autoResolve: readUserSettingBool(userId, 'duplicates_auto_resolve', false)
    };
  },
  async saveDuplicateSettings(input: Partial<DuplicateSettings>, userId: string): Promise<DuplicateSettings> {
    const current = await this.getDuplicateSettings(userId);
    const autoResolve = input.autoResolve !== undefined ? input.autoResolve : current.autoResolve;
    setUserSetting(userId, 'duplicates_auto_resolve', autoResolve ? 'true' : 'false');
    return { autoResolve };
  },
  async clearTagsForFile(fileId: string) {
    const result = db.prepare('DELETE FROM file_tags WHERE file_id = ?').run(fileId);
    return result.changes ?? 0;
  },
  async removeTagsBySourceUrl(fileId: string, sourceUrl: string) {
    db.prepare('DELETE FROM file_tags WHERE file_id = ? AND source_url = ?').run(fileId, sourceUrl);
  },
  async replaceTagsForSource(
    fileId: string,
    source: TagSource,
    tags: { tag: string; category: string; score?: number | null; sourceUrl?: string | null }[]
  ) {
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      const fileExists = db.prepare('SELECT 1 FROM files WHERE id = ?').get(fileId) as { 1?: number } | undefined;
      if (!fileExists) return;
      db.prepare('DELETE FROM file_tags WHERE file_id = ? AND source = ?').run(fileId, source);
      if (!tags.length) return;
      const insert = db.prepare(
        `INSERT INTO file_tags (file_id, tag, category, source, score, source_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of tags) {
        insert.run(
          fileId,
          item.tag,
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
  },
  async addManualTag(fileId: string, tag: string, category: string) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO file_tags (file_id, tag, category, source, score, source_url, created_at, updated_at)
       VALUES (?, ?, ?, 'MANUAL', NULL, NULL, ?, ?)
       ON CONFLICT(file_id, tag, source) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at`
    ).run(fileId, tag, category, now, now);
  },
  async removeManualTag(fileId: string, tag: string) {
    db.prepare('DELETE FROM file_tags WHERE file_id = ? AND tag = ? AND source = ?').run(fileId, tag, 'MANUAL');
  },
  async saveManualOrder(fileIds: string[], userId?: string) {
    const now = new Date().toISOString();
    const tx = db.transaction((order: string[], scopedUserId?: string) => {
      if (order.length === 0) {
        if (scopedUserId) {
          db.prepare(
            `DELETE FROM file_manual_order
             WHERE file_id IN (SELECT id FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?))`
          ).run(scopedUserId);
        } else {
          db.prepare('DELETE FROM file_manual_order').run();
        }
        return { saved: 0 };
      }
      const placeholders = order.map(() => '?').join(',');
      const existingRows = (scopedUserId
        ? db
            .prepare(
              `SELECT id FROM files
               WHERE id IN (${placeholders})
                 AND folder_id IN (SELECT id FROM folders WHERE user_id = ?)`
            )
            .all(...order, scopedUserId)
        : db.prepare(`SELECT id FROM files WHERE id IN (${placeholders})`).all(...order)) as { id: string }[];
      const existing = new Set(existingRows.map((row) => row.id));
      const validOrder = order.filter((id) => existing.has(id));

      if (validOrder.length === 0) {
        if (scopedUserId) {
          db.prepare(
            `DELETE FROM file_manual_order
             WHERE file_id IN (SELECT id FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?))`
          ).run(scopedUserId);
        } else {
          db.prepare('DELETE FROM file_manual_order').run();
        }
        return { saved: 0 };
      }

      const insert = db.prepare(
        `INSERT INTO file_manual_order (file_id, position, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`
      );
      validOrder.forEach((id, index) => {
        insert.run(id, index + 1, now);
      });
      if (scopedUserId) {
        const validPlaceholders = validOrder.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM file_manual_order
           WHERE file_id IN (SELECT id FROM files WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?))
             AND file_id NOT IN (${validPlaceholders})`
        ).run(scopedUserId, ...validOrder);
      } else {
        const validPlaceholders = validOrder.map(() => '?').join(',');
        db.prepare(`DELETE FROM file_manual_order WHERE file_id NOT IN (${validPlaceholders})`).run(...validOrder);
      }
      return { saved: validOrder.length };
    });

    return tx(fileIds, userId);
  },
  async removeProviderRunResultForFile(fileId: string, sourceUrl: string) {
    const rows = db.prepare('SELECT * FROM provider_runs WHERE file_id = ?').all(fileId) as any[];
    let removed = 0;
    for (const row of rows) {
      const run = mapProviderRunRow(row);
      const results = Array.isArray(run.results) ? run.results : [];
      if (!results.some((result) => result.sourceUrl === sourceUrl)) continue;
      const filtered = results.filter((result) => result.sourceUrl !== sourceUrl);
      const sorted = [...filtered].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const top = sorted[0];
      await dataStore.updateProviderRun(run.id, {
        results: filtered,
        sourceUrl: top?.sourceUrl ?? null,
        score: top?.score ?? null,
        thumbUrl: top?.thumbUrl ?? null
      });
      removed += results.length - filtered.length;
    }
    return removed;
  },
  async getSauceSettings(userId: string) {
    const display = readUserSettingJson<string[]>(userId, 'sauce_display', []);
    const targets = readUserSettingJson<string[]>(userId, 'sauce_targets', []);
    const displayInitialized = readUserSettingBool(userId, 'sauce_display_initialized', display.length > 0);
    return {
      display,
      targets,
      displayInitialized
    };
  },
  async saveSauceSettings(input: { display?: string[]; targets?: string[]; displayInitialized?: boolean }, userId: string) {
    const display = normalizeKeyList(input.display ?? []);
    const targets = normalizeKeyList(input.targets ?? []);
    writeUserSettingJson(userId, 'sauce_display', display);
    writeUserSettingJson(userId, 'sauce_targets', targets);
    const metaInitialized = readUserSettingBool(userId, 'sauce_display_initialized', false);
    const displayInitialized = metaInitialized || input.displayInitialized === true || display.length > 0;
    if (displayInitialized && !metaInitialized) {
      setUserSetting(userId, 'sauce_display_initialized', 'true');
    }
    return { display, targets, displayInitialized };
  },
  async getSauceDisplayInitialized(userId: string) {
    return readUserSettingBool(userId, 'sauce_display_initialized', false);
  },
  async setSauceDisplayInitialized(value: boolean, userId: string) {
    setUserSetting(userId, 'sauce_display_initialized', value ? 'true' : 'false');
  },

  getSignaturesBatch(
    fileIds: string[],
    sampleSize: number
  ): Map<string, { kind: string; data: Buffer; sourceHash: string }> {
    if (fileIds.length === 0) return new Map();
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT file_id, kind, data, source_hash FROM file_signatures WHERE sample_size = ? AND file_id IN (${placeholders})`
      )
      .all(sampleSize, ...fileIds) as { file_id: string; kind: string; data: Buffer; source_hash: string }[];
    const result = new Map<string, { kind: string; data: Buffer; sourceHash: string }>();
    for (const row of rows) {
      result.set(row.file_id, { kind: row.kind, data: row.data, sourceHash: row.source_hash });
    }
    return result;
  },

  setSignature(fileId: string, kind: string, sampleSize: number, data: Buffer, sourceHash: string) {
    db.prepare(
      `INSERT INTO file_signatures (file_id, kind, sample_size, data, source_hash)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET kind = excluded.kind, sample_size = excluded.sample_size, data = excluded.data, source_hash = excluded.source_hash, created_at = datetime('now')`
    ).run(fileId, kind, sampleSize, data, sourceHash);
  }
};
