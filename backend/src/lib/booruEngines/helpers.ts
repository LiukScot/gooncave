import type { PoolRecord, PopularWindow } from './types';

export const normalizeTag = (value: string): string =>
  value
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w:()-]+/g, '')
    .toLowerCase();

export const stripTrailingSlash = (url: string): string =>
  url.replace(/\/+$/, '');

export const safeJoin = (base: string, path: string): string => {
  const trimmedBase = stripTrailingSlash(base);
  if (!path.startsWith('/')) return `${trimmedBase}/${path}`;
  return `${trimmedBase}${path}`;
};

export const hostnameOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
};

export const basicAuthHeader = (username: string, apiKey: string): string =>
  `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}`;

export const escapeRegex = (value: string): string =>
  value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

/**
 * Post id that was published `seconds` ago, from two samples of the id
 * timeline: the newest post and one `sample` ids behind it.
 *
 * Gelbooru-style boorus reject every date metatag, so a time window can only
 * be expressed as `id:>N`. Ids advance at the site's upload rate, which the
 * caller measures rather than assumes. Measured over ~2 days the estimate
 * lands within 5% on a one-day window and ~15% on a month — the upload rate
 * itself drifts, so a "week" that reaches back eight days is the accuracy
 * ceiling here, not a bug to chase.
 */
export const idAtAge = (
  newestId: number,
  newestAt: number,
  sampleId: number,
  sampleAt: number,
  seconds: number
): number => {
  const elapsed = newestAt - sampleAt;
  const travelled = newestId - sampleId;
  if (elapsed <= 0 || travelled <= 0) return 0;
  return Math.max(0, Math.round(newestId - (travelled / elapsed) * seconds));
};

/** Seconds spanned by each popular window, and by "hot" where it needs one. */
export const WINDOW_SECONDS: Record<PopularWindow, number> = {
  day: 86_400,
  week: 7 * 86_400,
  month: 30 * 86_400
};

/**
 * UTC start date (YYYY-MM-DD) of a time window ending now, for engines whose
 * search accepts a `date:` metatag. `now` is injectable for tests only.
 */
export const windowStartDate = (
  seconds: number,
  now: Date = new Date()
): string =>
  new Date(now.getTime() - seconds * 1000).toISOString().slice(0, 10);

export const toIsoOrNull = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // unix seconds (moebooru, sankaku)
    return new Date(value * 1000).toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

/** File extension without the dot, from a URL that may carry a query. */
export const extensionOf = (url: string | null): string | null => {
  if (!url) return null;
  const path = url.split(/[?#]/)[0];
  const dot = path.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = path.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : null;
};

export const toNumberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

// Query params that carry a credential or session token. Gelbooru-style
// engines require api_key/user_id in the URL itself, so the URL can't avoid
// them — but the URL must never reach a log or an error returned to the client
// with the secret intact (issue #200 finding 1).
const SECRET_QUERY_KEYS = ['api_key', 'pass_hash', 'login', 'token'];

// Replace the value of any secret-bearing query param with `***` in an
// arbitrary string (a bare URL, or an error message that embeds one). Operates
// textually so it also redacts URLs nested inside undici/fetch error messages,
// not just well-formed standalone URLs.
export const redactUrlSecrets = (value: string): string => {
  let redacted = value;
  for (const key of SECRET_QUERY_KEYS) {
    redacted = redacted.replace(
      new RegExp(`([?&]${escapeRegex(key)}=)[^&\\s'"]+`, 'gi'),
      '$1***'
    );
  }
  return redacted;
};

/**
 * Parent post id, from the mix of shapes the boorus use for "no parent":
 * null, an empty string, the number 0, or the string "0".
 */
export const toParentId = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return !text || text === '0' ? null : text;
};

/** Booru booleans: real ones on the JSON APIs, "true"/"1" on gelbooru's. */
export const toBoolean = (value: unknown): boolean =>
  value === true || value === 1 || value === 'true' || value === '1';

/**
 * A pool as danbooru-descended APIs serve it at `/pools/<id>.json`: e621 and
 * danbooru answer with the same field names, so one reader covers both.
 */
export const toPoolRecord = (body: unknown): PoolRecord | null => {
  if (!body || typeof body !== 'object') return null;
  const row = body as {
    id?: number | string | null;
    name?: string | null;
    post_ids?: (number | string)[] | null;
    post_count?: number | null;
  };
  if (row.id === null || row.id === undefined) return null;
  const postIds = (row.post_ids ?? []).map((id) => String(id));
  return {
    id: String(row.id),
    // Pools are stored with underscores; the reader wants spaces.
    name: (row.name ?? '').replace(/_/g, ' ').trim() || `Pool ${row.id}`,
    postCount: toNumberOrNull(row.post_count) ?? postIds.length,
    postIds
  };
};
