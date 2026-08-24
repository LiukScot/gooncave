import type {
  FileRecord,
  FileTagRecord,
  FolderType,
  ProviderRunRecord,
  TagSource
} from '../../../db/types';
import type { MediaKind } from '../../../lib/scanner';
import { isTagQueryEmpty, type TagQuery } from '../../../lib/tagQuery';
import { sqlite } from '../../client';

export type FileListSort = 'rated' | 'mtime_desc' | 'mtime_asc' | 'random';

// A file can be voted once per this window; the API exposes the deadline as
// nextVoteAt so clients never need their own copy of the constant.
export const VOTE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// bun:sqlite binds a narrower value set than better-sqlite3's loose typing.
type SqlBindParam = string | number | bigint | boolean | null | Uint8Array;

export type FileListOptions = {
  folderId?: string;
  tagQuery?: TagQuery;
  mediaType?: MediaKind;
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

export type FileWithVoteRow = FileRow & {
  vote_score?: number | null;
  last_vote_at?: string | null;
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
  canonical_tag?: string | null;
  category: string;
  source: TagSource;
  score?: number | null;
  source_url?: string | null;
  created_at: string;
  updated_at: string;
};

// SQLite caps how many values one statement may bind, so any `IN (...)` over
// a caller-sized id list has to be split. 500 keeps every statement well
// under the limit whatever the build.
export const SQLITE_PARAM_CHUNK = 500;

export const chunkIds = (ids: string[]): string[][] => {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += SQLITE_PARAM_CHUNK) {
    out.push(ids.slice(i, i + SQLITE_PARAM_CHUNK));
  }
  return out;
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

export const withSqliteRetry = async <T>(
  operation: () => T | Promise<T>
): Promise<T> => {
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

export const nextVoteAtFrom = (lastVoteAt?: string | null) => {
  if (!lastVoteAt) return null;
  const votedAt = Date.parse(lastVoteAt);
  if (Number.isNaN(votedAt)) return null;
  return new Date(votedAt + VOTE_COOLDOWN_MS).toISOString();
};

export const mapFileRowWithVote = (row: FileWithVoteRow): FileRecord => ({
  ...mapFileRow(row),
  voteScore: Number(row.vote_score ?? 0),
  nextVoteAt: nextVoteAtFrom(row.last_vote_at)
});

export const mapProviderRunRow = (row: ProviderRunRow): ProviderRunRecord => ({
  id: row.id,
  fileId: row.file_id,
  provider: row.provider,
  status: row.status,
  cachedHit: Boolean(row.cached_hit),
  score:
    row.score === null || row.score === undefined ? null : Number(row.score),
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
  canonicalTag: row.canonical_tag || row.tag,
  category: row.category,
  source: row.source as TagSource,
  score: row.score ?? null,
  sourceUrl: row.source_url ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

// A file matches a term when one of its tags collapses to that term, or
// implies it: searching `canine` has to find the file tagged `husky`. The
// implication side is a subquery rather than a term list expanded in JS
// because a broad tag reaches thousands of descendants, and `idx_tag_
// implications_implied` answers it without materialising any of them.
// Tags the user removed by hand are excluded from both sides.
const tagMatchCondition = (terms: string[]) => {
  const placeholders = terms.map(() => '?').join(',');
  return {
    sql: `(
        ft.canonical_tag IN (${placeholders})
        OR ft.canonical_tag IN (
          SELECT ti.tag FROM tag_implications ti WHERE ti.implied IN (${placeholders})
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM file_tag_suppressions s
        WHERE s.file_id = ft.file_id AND s.tag = ft.tag
      )`,
    params: [...terms, ...terms] as SqlBindParam[]
  };
};

/**
 * Turns a parsed search into joins and where-clauses.
 *
 * Required terms and the alternative group become joins so the tag index
 * picks the candidate files before the outer query touches them; excluded
 * terms can only be a NOT EXISTS.
 */
export const buildFileTagFilter = (tagQuery?: TagQuery) => {
  const empty = {
    join: '',
    joinParams: [] as SqlBindParam[],
    where: [] as string[],
    whereParams: [] as SqlBindParam[]
  };
  if (!tagQuery || isTagQueryEmpty(tagQuery)) return empty;

  const joins: string[] = [];
  const joinParams: SqlBindParam[] = [];
  const where: string[] = [];
  const whereParams: SqlBindParam[] = [];

  const addJoin = (terms: string[], alias: string) => {
    const match = tagMatchCondition(terms);
    joins.push(
      `JOIN (
        SELECT DISTINCT ft.file_id FROM file_tags ft WHERE ${match.sql}
      ) ${alias} ON ${alias}.file_id = f.id`
    );
    joinParams.push(...match.params);
  };

  tagQuery.all.forEach((term, index) => addJoin([term], `tag_all_${index}`));
  if (tagQuery.any.length > 0) addJoin(tagQuery.any, 'tag_any');

  for (const term of tagQuery.none) {
    const match = tagMatchCondition([term]);
    where.push(
      `NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id AND ${match.sql})`
    );
    whereParams.push(...match.params);
  }

  for (const filter of tagQuery.score) {
    // A file nobody has voted on has no row at all, and reads as 0 — the
    // same score the vote control shows it. Read as a scalar subquery so
    // this works in the COUNT query too, which joins no votes of its own.
    const comparison = `COALESCE(
        (SELECT fv.score FROM file_votes fv WHERE fv.file_id = f.id), 0
      ) ${filter.op === '=' ? '=' : filter.op} ?`;
    where.push(filter.negated ? `NOT (${comparison})` : comparison);
    whereParams.push(filter.value);
  }

  return {
    join: joins.join('\n      '),
    joinParams,
    where,
    whereParams
  };
};

export const buildFileWhereClause = (
  options: Pick<FileListOptions, 'folderId' | 'mediaType'>,
  userId?: string,
  extra: { conditions: string[]; params: SqlBindParam[] } = {
    conditions: [],
    params: []
  }
) => {
  const where: string[] = [];
  const params: SqlBindParam[] = [];
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
  where.push(...extra.conditions);
  params.push(...extra.params);
  return {
    clause: where.length ? ` WHERE ${where.join(' AND ')}` : '',
    params
  };
};

// SQLite has no built-in hash and bun:sqlite cannot register custom scalar
// functions, so a stable seeded shuffle is computed inline. We hash the seed
// into per-position weights, then score text ids by a weighted sum of selected
// characters. This keeps seeded random ordering deterministic for UUID-like
// TEXT ids (file ids are not numeric).
const MINSTD_MODULUS = 2147483647;

const seedToOrderParams = (
  seed: string
): [number, number, number, number, number, number, number] => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const nextWeight = () => {
    hash ^= 0x9e3779b9;
    hash = Math.imul(hash, 0x01000193);
    return ((hash >>> 0) % (MINSTD_MODULUS - 1)) + 1;
  };
  const w1 = nextWeight();
  const w2 = nextWeight();
  const w3 = nextWeight();
  const w4 = nextWeight();
  const w5 = nextWeight();
  const w6 = nextWeight();
  const bias = nextWeight();
  return [w1, w2, w3, w4, w5, w6, bias];
};

export const buildFileOrder = (sort?: FileListSort, seed?: string) => {
  switch (sort) {
    // Reads the `v` vote join the caller already added for the score column,
    // rather than joining file_votes a second time under its own alias.
    // Ties break on who reached that score first: every vote writes score and
    // last_vote_at together, so last_vote_at is when the file got where it is.
    // Files nobody ever voted on have no such moment and sort after the ones
    // that do, keeping their usual newest-first order.
    case 'rated':
      return {
        join: '',
        clause: `COALESCE(v.score, 0) DESC,
          CASE WHEN v.last_vote_at IS NULL THEN 1 ELSE 0 END ASC,
          v.last_vote_at ASC,
          f.mtime DESC,
          f.id DESC`,
        params: [] as SqlBindParam[]
      };
    case 'mtime_desc':
      return {
        join: '',
        clause: 'f.mtime DESC, f.id DESC',
        params: [] as SqlBindParam[]
      };
    case 'mtime_asc':
      return {
        join: '',
        clause: 'f.mtime ASC, f.id ASC',
        params: [] as SqlBindParam[]
      };
    case 'random': {
      const normalizedSeed = seed?.trim();
      if (normalizedSeed) {
        return {
          join: '',
          clause: `(
            (
              ifnull(unicode(substr(f.id, 1, 1)), 0) * ?
              + ifnull(unicode(substr(f.id, 2, 1)), 0) * ?
              + ifnull(unicode(substr(f.id, 3, 1)), 0) * ?
              + ifnull(unicode(substr(f.id, 4, 1)), 0) * ?
              + ifnull(unicode(substr(f.id, -1, 1)), 0) * ?
              + ifnull(unicode(substr(f.id, -2, 1)), 0) * ?
              + ?
            ) % 2147483647
          ) ASC, f.id ASC`,
          params: seedToOrderParams(normalizedSeed) as SqlBindParam[]
        };
      }
      return { join: '', clause: 'RANDOM()', params: [] as SqlBindParam[] };
    }
    default:
      return {
        join: '',
        clause: 'f.created_at DESC, f.id DESC',
        params: [] as SqlBindParam[]
      };
  }
};

export const buildPaginationClause = (limit?: number, offset?: number) => {
  if (typeof limit === 'number') {
    if (typeof offset === 'number') {
      return {
        clause: ' LIMIT ? OFFSET ?',
        params: [limit, Math.max(0, offset)] as SqlBindParam[]
      };
    }
    return { clause: ' LIMIT ?', params: [limit] as SqlBindParam[] };
  }
  if (typeof offset === 'number') {
    return {
      clause: ' LIMIT -1 OFFSET ?',
      params: [Math.max(0, offset)] as SqlBindParam[]
    };
  }
  return { clause: '', params: [] as SqlBindParam[] };
};

export { sqlite };
