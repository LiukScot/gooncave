import { z } from 'zod';

const providerDiagnosticSchema = z.object({
  id: z.string().uuid(),
  operation: z.enum(['search', 'detail', 'favorite', 'provider-action']),
  startedAt: z.string().datetime(), updatedAt: z.string().datetime(),
  elapsedMs: z.number().nonnegative(),
  outcome: z.enum(['pending', 'completed', 'failed', 'cancelled']),
  count: z.number().int().positive(), requestCount: z.number().int().nonnegative(),
  providers: z.array(z.string().max(40)).max(24),
  retries: z.number().int().nonnegative(), challenges: z.number().int().nonnegative(),
  rateLimits: z.number().int().nonnegative(), sharedWaitMs: z.number().nonnegative(),
  attempts: z.array(z.object({
    provider: z.string().max(40), status: z.number().int().nullable(),
    elapsedMs: z.number().nonnegative(), outcome: z.enum(['pending', 'response', 'network-error'])
  })).max(24)
});

export type ProviderDiagnostic = z.infer<typeof providerDiagnosticSchema>;

const syncSettingsSchema = z.object({
  url: z.string().nullable(),
  username: z.string().nullable(),
  hasPassword: z.boolean()
});
export type SyncSettings = z.infer<typeof syncSettingsSchema>;
const syncStatusSchema = z.object({
  state: z.enum(['off', 'idle', 'syncing', 'error']),
  lastSyncAt: z.string().nullable(),
  error: z.string().nullable()
});
export type SyncStatus = z.infer<typeof syncStatusSchema>;
const originalsSchema = z.object({
  upload: z.boolean(),
  keepAll: z.boolean(),
  defaultKeepAll: z.boolean(),
  folderConnected: z.boolean(),
  localBytes: z.number().nonnegative(),
  status: z.object({
    state: z.enum(['idle', 'uploading', 'downloading', 'error']).optional(),
    done: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    error: z.string().nullable().optional()
  })
});
export type Originals = z.infer<typeof originalsSchema>;
const sizeSchema = z.object({ files: z.number().int().nonnegative(), bytes: z.number().nonnegative() });
const keepPreviewSchema = z.object({ download: sizeSchema, free: sizeSchema });
export type KeepPreview = z.infer<typeof keepPreviewSchema>;
const trashSettingsSchema = z.object({ enabled: z.boolean(), days: z.number().int().positive() });
const trashSchema = z.object({
  files: z.array(z.object({
    sha256: z.string().min(1),
    path: z.string(),
    thumbUrl: z.string().nullable(),
    purgeAt: z.string().datetime()
  })),
  days: z.number().int().positive()
});
export type TrashSettings = z.infer<typeof trashSettingsSchema>;
export const uploadResultSchema = z.object({
  uploaded: z.array(z.object({ name: z.string(), fileId: z.string() })),
  rejected: z.array(z.object({ name: z.string(), reason: z.string() }))
});

export type UploadResult = z.infer<typeof uploadResultSchema>;

const importResultSchema = z.object({
  applied: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative()
});
export type ImportResult = z.infer<typeof importResultSchema>;
const libraryProgressSchema = z.object({
  scanning: z.boolean(),
  files: z.number().int().nonnegative(),
  found: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative()
});
export type LibraryProgress = z.infer<typeof libraryProgressSchema>;

const taggingStatusSchema = z.object({
  available: z.boolean(), enabled: z.boolean(), model: z.string().max(200),
  modelBytes: z.number().int().positive(), downloadedBytes: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(), completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(), error: z.string().nullable(),
  state: z.enum(['idle', 'starting', 'downloading', 'loading', 'tagging', 'ready', 'failed'])
});

const resolveApiBase = () => {
  const envBase = import.meta.env.VITE_API_BASE_URL;
  if (envBase && envBase.length > 0) return envBase;
  // Same-origin in dev: the Vite proxy forwards /api to the backend, so the
  // app works from localhost and from a LAN address alike without CORS or a
  // cookie scoped to the wrong host.
  if (import.meta.env.DEV) return '/api';
  if (typeof window !== 'undefined') return window.location.origin;
  return 'http://localhost:4100';
};

export const API_BASE = resolveApiBase();

const apiFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  return fetch(input, {
    ...init,
    credentials: 'include'
  });
};

export type DeviceProfile = {
  capabilities?: { library: boolean; boorus: boolean; processing: boolean; favorites?: boolean; favoritesAutoSync?: boolean; subscriptions?: boolean; sourceMatching?: boolean; tagging?: boolean; duplicates?: boolean; autoFavorite?: boolean; tagRefresh?: boolean; sync?: boolean; browserSignIn?: boolean; openFolder?: boolean };
  id: string;
  username: string;
  libraryRoot: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

export type Folder = {
  id: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  lastScanAt: string | null;
  status: 'IDLE' | 'SCANNING';
};

export type FileItem = {
  id: string;
  folderId: string;
  path: string;
  /** REMOTE: shown from synced metadata; the original is not on this device yet. */
  locationType: 'LOCAL' | 'REMOTE';
  sizeBytes: number;
  mtime: string;
  sha256: string;
  phash: string | null;
  mediaType: 'IMAGE' | 'VIDEO';
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbPath: string | null;
  thumbUrl: string | null;
  voteScore: number;
  /** ISO timestamp of the next allowed vote, null when never voted. */
  nextVoteAt: string | null;
  providers?: Partial<Record<'SAUCENAO' | 'FLUFFLE', ProviderRun>>;
  favoriteProviders?: string[];
  /** The booru post this file came from has a parent or children. */
  hasRelations?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ExtraSettings = {
  gamesTabEnabled: boolean;
  voteSystemEnabled: boolean;
  autoVoteOnFavorite: boolean;
  /** Marks Explore posts read and offers "Unread only" there. */
  readTrackingEnabled: boolean;
  exploreStackDuplicates: boolean;
  developerMode: boolean;
  maxGridColumns: number;
};

/**
 * Mirrors the backend defaults, used while the real settings are still in
 * flight so nothing flickers out of the UI on first paint.
 */
export const EXTRA_SETTINGS_DEFAULTS: ExtraSettings = {
  gamesTabEnabled: true,
  voteSystemEnabled: false,
  autoVoteOnFavorite: true,
  readTrackingEnabled: true,
  exploreStackDuplicates: false,
  developerMode: false,
  maxGridColumns: 0
};

export type BlacklistSettings = {
  /** Normalised tags; a file or post carrying any of them is hidden. */
  tags: string[];
  applyToExplore: boolean;
  applyToGallery: boolean;
};

/** Mirrors the backend defaults, used while the real settings load. */
export const BLACKLIST_DEFAULTS: BlacklistSettings = {
  tags: [],
  applyToExplore: true,
  applyToGallery: false
};

export type ArtistSubscriptionSource = {
  siteId: string;
  siteName: string;
  artists: string[];
  error: string | null;
};

export type SubscriptionSettings = {
  tags: string[];
  artistSources: ArtistSubscriptionSource[];
  targets: Array<{ kind: 'tag' | 'artist'; value: string }>;
};

/** A followed pool, with what the subscriptions list shows of it. */
export type PoolSubscription = {
  siteId: string;
  siteName: string;
  poolId: string;
  name: string;
  postCount: number;
  coverUrl: string | null;
};

export type DuplicateFile = {
  id: string;
  folderId: string;
  path: string;
  mtime?: string;
  mediaType: 'IMAGE' | 'VIDEO';
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbUrl: string | null;
  favoriteProviders?: string[];
  providers?: Partial<Record<'SAUCENAO' | 'FLUFFLE', ProviderRun>>;
};

export type DuplicateGroup = {
  key: string;
  files: DuplicateFile[];
};

export type DuplicateScanStats = {
  totalFiles: number;
  eligibleFiles: number;
  comparedFiles: number;
  comparisons: number;
  skippedNoSignature: number;
  pixelThreshold: number;
};

export type DuplicateScanResult = {
  groups: DuplicateGroup[];
  stats: DuplicateScanStats;
};

export type DuplicateScanProgress = {
  phase: 'preparing' | 'exact-hash' | 'phash' | 'signature' | 'done';
  processed: number;
  total: number;
  comparisons: number;
  groups: number;
  skippedNoSignature: number;
  message: string;
};

export type DuplicateScanStatus = {
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt: string | null;
  updatedAt: string;
  progress: DuplicateScanProgress | null;
  result: DuplicateScanResult | null;
  error: string | null;
};

export type DuplicateSettings = {
  enabled: boolean;
  style: 'favorite_all' | 'preferred_only' | null;
  preferredProviders: string[];
};

export type DuplicatePolicyAction = {
  id: string;
  groupKey: string;
  kind: 'add_favorite' | 'confirm_favorite' | 'remove_favorite' | 'reuse_file' | 'delete_file' | 'attention';
  status: 'planned' | 'completed' | 'failed' | 'skipped';
  provider: string | null;
  remoteId: string | null;
  fileId: string | null;
  fileName: string | null;
  message: string;
};

export type DuplicatePolicyRun = {
  id: string;
  kind: 'preview' | 'apply';
  status: 'planning' | 'ready' | 'running' | 'completed' | 'partial' | 'failed';
  style: Exclude<DuplicateSettings['style'], null>;
  preferredProviders: string[];
  reason: string;
  totalGroups: number;
  processedGroups: number;
  counts: {
    added: number;
    removed: number;
    reused: number;
    deleted: number;
    needsAttention: number;
  };
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  actions: DuplicatePolicyAction[];
};

export type DuplicateScanOptions = {
  intent?: 'automatic' | 'manual';
  mediaType?: 'IMAGE' | 'VIDEO' | 'ALL';
  pixelThreshold?: number;
  sampleSize?: number;
  videoFrames?: number;
  maxComparisons?: number;
};

export type SourceEntry = {
  key: string;
  label: string;
  count: number;
};

export type SourceSettings = {
  display: string[];
  targets: string[];
  displayInitialized?: boolean;
};

export type SourceProgress = {
  total: number;
  matched: number;
  failed: number;
  pending: number;
  videos: number;
  failedImages: number;
};

export type CredentialProvider = 'E621' | 'DANBOORU' | 'SAUCENAO';

export type CredentialSummary = {
  provider: CredentialProvider;
  username: string | null;
  hasApiKey: boolean;
  source: 'db' | 'env' | 'none';
  updatedAt: string | null;
};

// Tag source is an opaque string: it can be a legacy preset key ('E621',
// 'DANBOORU', 'GELBOORU', 'YANDERE', 'KONACHAN', 'SANKAKU', 'IDOL_COMPLEX'),
// the special values 'WD14' or 'MANUAL', or a user_booru_sites.id UUID for a
// fully custom user-added site.
export type FileTag = {
  tag: string;
  /** The tag this one collapses to once aliases are applied. */
  canonicalTag: string;
  category: string;
  source: string;
  score: number | null;
  sourceUrl: string | null;
};

export type BooruEngineType =
  | 'danbooru'
  | 'e621'
  | 'moebooru'
  | 'gelbooru'
  | 'sankaku'
  | 'philomena'
  | 'shimmie'
  | 'szurubooru'
  | 'furaffinity';

export type BooruCredentialSchema =
  | 'username+apikey'
  | 'userid+apikey'
  | 'username+session-cookie'
  | 'apikey-only'
  | 'token'
  | 'none';

export type BooruEngineCapabilities = {
  favorites: boolean;
  tags: boolean;
  sourceMatch: boolean;
  search: boolean;
  vote: boolean;
};

/** Progress of a re-read of one site's tags. One job per account. */
export type TagRefreshProgress = {
  status: 'idle' | 'running' | 'done' | 'error';
  siteId: string | null;
  processed: number;
  total: number;
  updated: number;
  unchanged: number;
  failed: number;
  startedAt: string | null;
  updatedAt: string;
  error: string | null;
};

export type BooruSite = {
  id: string;
  name: string;
  engine: BooruEngineType;
  baseUrl: string;
  username: string | null;
  hasApiKey: boolean;
  hasSessionCookie: boolean;
  isPreset: boolean;
  presetKey: string | null;
  enabled: boolean;
  siteAutoSyncMidnight: boolean;
  siteReverseSyncEnabled: boolean;
  siteAutoFavEnabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  engineCredentialSchema: BooruCredentialSchema;
  engineSupportsSessionCookie: boolean;
};

export type BooruDetectionAttemptStatus =
  'matched' | 'no-match' | 'http-error' | 'network-error' | 'timeout';

export type BooruDetectionAttempt = {
  engine: BooruEngineType;
  status: BooruDetectionAttemptStatus;
  httpStatus?: number;
  error?: string;
};

export type BooruDetectionSample = {
  postId: string;
  thumbUrl: string | null;
  postUrl: string;
};

export type BooruDetectionResult =
  | {
      engine: BooruEngineType;
      confidence: 'hostname' | 'probe';
      credentialSchema: BooruCredentialSchema;
      defaultCapabilities: BooruEngineCapabilities | null;
      supportsSessionCookie: boolean;
      sample: BooruDetectionSample | null;
      attempts: BooruDetectionAttempt[];
    }
  | {
      error: 'unknown';
      tried: BooruEngineType[];
      attempts: BooruDetectionAttempt[];
    }
  | {
      error: 'unreachable';
      message: string;
      attempts: BooruDetectionAttempt[];
    };

export type BooruEngineCatalog = {
  engines: Array<{
    type: BooruEngineType;
    credentialSchema: BooruCredentialSchema;
    defaultCapabilities: BooruEngineCapabilities;
    supportedExploreSorts: Array<'new' | 'hot' | 'popular'>;
    supportsExploreTagSearch: boolean;
    supportsSessionCookie: boolean;
    supportsRelations: boolean;
    supportsPools: boolean;
  }>;
  presets: Array<{
    key: string;
    name: string;
    engine: BooruEngineType;
    baseUrl: string;
  }>;
};

type FoldersResponse = { folders: Folder[] };
type FilesResponse = { files: FileItem[]; total?: number };
type SourceResponse = {
  sources: SourceEntry[];
  settings: SourceSettings;
  progress: SourceProgress;
};
type TagsResponse = {
  tags: FileTag[];
  /** Tags the stored ones imply, derived server-side and never stored. */
  implied: string[];
  favoriteSources?: string[];
  favoriteSourceLinks?: FavoriteSourceLink[];
};

export type FileSourceText = {
  siteName: string;
  sourceUrl: string;
  title: string | null;
  description: string | null;
};

export type FavoriteSourceLink = {
  siteName: string;
  sourceUrl: string;
};

export type FileTagRefreshStatus = 'queued' | 'running' | 'done' | 'error';

type FileTagRefreshJob = {
  id: string;
  fileId: string;
  status: FileTagRefreshStatus;
  error: string | null;
};

type FileTagRefreshResponse = { job: FileTagRefreshJob };

const FILE_TAG_REFRESH_POLL_MS = 500;

export type TagSuggestion = { tag: string; files: number };

type ShortcutsResponse = { bindings: Record<string, string> };


export type ExploreSort = 'new' | 'hot' | 'popular' | 'subscribed';
export type ExploreWindow = 'day' | 'week' | 'month' | 'year' | 'all';

export type ExplorePost = {
  remoteId: string;
  previewUrl: string | null;
  /** The preview served by this app, so its pixels can be read for a tint. */
  colorSourceUrl?: string | null;
  sampleUrl: string | null;
  fileUrl: string | null;
  width: number | null;
  height: number | null;
  score: number | null;
  rating: string | null;
  md5: string | null;
  sourceUrls?: string[];
  matchPreviewUrl?: string | null;
  /** Client-only pixels for optional same-page visual matching. */
  visualSignature?: number[];
  /** Matches an image already saved as a favorite in the local Gallery. */
  galleryFavoriteMatch?: boolean;
  createdAt: string | null;
  tags: { tag: string; category: string }[];
  favCount: number | null;
  uploader: string | null;
  fileExt: string | null;
  fileSize: number | null;
  /** Already in the user's favorites, per the booru or the local library. */
  favorited: boolean;
  /**
   * Already shown to this user, so the Unread only filter can drop it. Absent
   * on posts reached through a pool or relation panel, which list everything.
   */
  read?: boolean;
  /** The vote already cast on the booru: 1, -1, 0 for none, null if unknown. */
  voted: 1 | -1 | 0 | null;
  siteId: string;
  siteName: string;
  engine: BooruEngineType;
  sourceUrl: string;
  /** Post this one is a variant of, null when it is not a child. */
  parentId: string | null;
  /** Whether other posts on the booru name this one as their parent. */
  hasChildren: boolean;
  /**
   * Pools this post is a page of. `null` means the booru's listing does not
   * say — the server has to ask — and `[]` means it said "none".
   */
  poolIds: string[] | null;
};

/** A post plus the library file holding it, when this account saved it. */
export type LibraryAwarePost = ExplorePost & {
  localFileId: string | null;
};

/** One pool the open post is a page of, with the pages either side of it. */
export type PoolNavigator = {
  poolId: string;
  siteId: string;
  siteName: string;
  name: string;
  /** 1-based page number of the open post. */
  position: number;
  postCount: number;
  /** Ids: the page itself is read when the reader asks for it. */
  prevId: string | null;
  nextId: string | null;
};

export type PoolPagePost = LibraryAwarePost & { position: number };

export type PoolPage = {
  poolId: string;
  siteId: string;
  siteName: string;
  name: string;
  postCount: number;
  page: number;
  pageSize: number;
  posts: PoolPagePost[];
  /** The whole pool's order, so the detail can step past this page. */
  postIds: string[];
};

/**
 * One post of a parent/child group. A whole post, because clicking one opens
 * it inside GoonCave rather than on the booru.
 */
export type RelatedPost = ExplorePost & {
  isParent: boolean;
  isCurrent: boolean;
  /** The library file holding this post, when it was already saved. */
  localFileId: string | null;
};

/** One site failing must not blank the page, so failures travel beside results. */
export type ExploreSiteError = {
  siteId: string;
  siteName: string;
  error: string;
};

type ExploreSearchResponse = {
  posts: ExplorePost[];
  siteErrors: ExploreSiteError[];
  sites: string[];
};

type SubscriptionFeedResponse = {
  posts: ExplorePost[];
  hasMore: boolean;
  nextCursor: string | null;
  ready: boolean;
};
export type ProviderRun = {
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

type ProvidersResponse = { providers: ProviderRun[] };
type ProviderRunResponse = { providerRun?: ProviderRun; error?: string };
type DuplicateScanStartResponse = {
  status: 'started' | 'busy';
  state: DuplicateScanStatus;
};
type DuplicateScanStatusResponse = DuplicateScanStatus;
type DuplicateSettingsResponse = DuplicateSettings;
type ClearTagsResponse = { status: string; removed: number };
type FileVoteResponse = {
  status: string;
  voteScore: number;
  nextVoteAt: string | null;
};
type FavoriteSyncResult = {
  provider: string;
  siteName: string;
  fetched: number;
  added: number;
  removed: number;
  skipped: number;
  errors: string[];
};
type FavoriteSyncProgress = {
  provider: string;
  siteName: string;
  stage: 'idle' | 'fetching' | 'downloading' | 'deleting' | 'done' | 'error';
  fetched: number;
  total: number;
  processed: number;
  added: number;
  removed: number;
  skipped: number;
  errors: string[];
};
export type FavoriteSyncStatus = {
  status: 'idle' | 'running' | 'done' | 'error';
  message: string;
  startedAt: string | null;
  updatedAt: string;
  progress: { providers: FavoriteSyncProgress[] } | null;
  results: FavoriteSyncResult[];
};
type FavoriteSyncResponse = {
  status: 'started' | 'busy';
  state: FavoriteSyncStatus;
};
type CredentialsResponse = { credentials: CredentialSummary[] };
type CredentialUpdateResponse = { credential: CredentialSummary };


const jsonHeaders = { 'Content-Type': 'application/json' };

export const extractErrorMessage = (text: string, fallback: string) => {
  let message = text || fallback;
  if (text) {
    try {
      const parsed = JSON.parse(text) as {
        error?: string;
        message?: string;
        statusCode?: number;
        issues?: Array<{ message?: string }>;
      };
      const firstIssue = parsed?.issues?.find(
        (issue) => issue?.message
      )?.message;
      // Fastify's own body for a thrown error: `error` is only the status
      // text ("Internal Server Error") and the reason sits in `message`.
      const thrownMessage =
        parsed?.statusCode !== undefined ? parsed.message : undefined;
      const parsedMessage = firstIssue || thrownMessage || parsed?.error;
      if (parsedMessage) {
        message = parsedMessage;
      }
    } catch (err) {
      // Non-JSON body (plain text, HTML, empty) is the common case for
      // proxy/gateway errors, so we keep the raw text we already have in
      // `message`. Surface the parse failure on the console so a malformed
      // JSON response from our own backend doesn't disappear silently.

      console.debug('extractErrorMessage: response body was not JSON', err);
    }
  }
  return message;
};

/** The machine-readable `code` of a thrown backend error, when it has one. */
const extractErrorCode = (text: string): string | undefined => {
  try {
    const code = (JSON.parse(text) as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
};

const handle = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const text = await res.text();
    const message = extractErrorMessage(text, res.statusText);
    const error = new Error(message) as Error & {
      status?: number;
      code?: string;
    };
    error.status = res.status;
    error.code = extractErrorCode(text);
    throw error;
  }
  return res.json() as Promise<T>;
};

const tagDatabaseStatusSchema = z.object({
  state: z.enum(['waiting', 'queued', 'running', 'ready', 'failed']),
  importedAt: z.string().nullable(),
  error: z.string().nullable()
});

export const api = {
  getSyncSettings: async () => {
    const response = await apiFetch(`${API_BASE}/sync/settings`);
    return syncSettingsSchema.parse(await handle<unknown>(response));
  },
  /** Checks the folder before saving. Leave `password` out to keep the saved one. */
  connectSync: async (input: { url: string; username: string; password?: string }) => {
    const response = await apiFetch(`${API_BASE}/sync/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    return syncSettingsSchema.parse(await handle<unknown>(response));
  },
  disconnectSync: async () => {
    const response = await apiFetch(`${API_BASE}/sync/settings`, { method: 'DELETE' });
    return syncSettingsSchema.parse(await handle<unknown>(response));
  },
  getSyncStatus: async () => {
    const response = await apiFetch(`${API_BASE}/sync/status`);
    return syncStatusSchema.parse(await handle<unknown>(response));
  },
  getOriginals: async () => {
    const response = await apiFetch(`${API_BASE}/originals`);
    return originalsSchema.parse(await handle<unknown>(response));
  },
  updateOriginals: async (input: { upload?: boolean; keepAll?: boolean }) => {
    const response = await apiFetch(`${API_BASE}/originals`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
    });
    return originalsSchema.parse(await handle<unknown>(response));
  },
  /** What `keepAll` would download, and at most what it would free on this device. */
  previewKeepAll: async (keepAll: boolean) => {
    const response = await apiFetch(`${API_BASE}/originals/preview?keepAll=${keepAll}`);
    return keepPreviewSchema.parse(await handle<unknown>(response));
  },
  /** Whether this device keeps the file whatever the Keep every file setting says. */
  getKept: async (fileId: string) => {
    const response = await apiFetch(`${API_BASE}/files/${fileId}/keep`);
    return z.object({ kept: z.boolean() }).parse(await handle<unknown>(response)).kept;
  },
  /** Keeping downloads the original when it is missing, so this resolves once it is here. */
  setKept: async (fileId: string, kept: boolean) => {
    const response = await apiFetch(`${API_BASE}/files/${fileId}/keep`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kept })
    });
    return z.object({ kept: z.boolean() }).parse(await handle<unknown>(response)).kept;
  },
  /** Why a file's original does not load, from the core's error body; null when it loads now. */
  contentError: async (fileId: string) => {
    const response = await apiFetch(`${API_BASE}/files/${fileId}/content`);
    if (response.ok) {
      await response.body?.cancel();
      return null;
    }
    const body = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
    return body.success ? body.data.error : `The device answered ${response.status}.`;
  },
  getTrash: async () => {
    const response = await apiFetch(`${API_BASE}/trash`);
    return trashSchema.parse(await handle<unknown>(response));
  },
  getTrashSettings: async () => {
    const response = await apiFetch(`${API_BASE}/trash/settings`);
    return trashSettingsSchema.parse(await handle<unknown>(response));
  },
  updateTrashSettings: async (enabled: boolean) => {
    const response = await apiFetch(`${API_BASE}/trash/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled })
    });
    return trashSettingsSchema.parse(await handle<unknown>(response));
  },
  restoreFile: async (sha256: string) => {
    const response = await apiFetch(`${API_BASE}/trash/${sha256}/restore`, { method: 'POST' });
    await handle<unknown>(response);
  },
  emptyTrash: async () => {
    const response = await apiFetch(`${API_BASE}/trash/empty`, { method: 'POST' });
    await handle<unknown>(response);
  },
  syncNow: async () => {
    const response = await apiFetch(`${API_BASE}/sync/now`, { method: 'POST' });
    await handle<unknown>(response);
  },
  downloadBackup: async () => {
    const response = await apiFetch(`${API_BASE}/backup`);
    if (!response.ok) await handle<unknown>(response);
    return response.blob();
  },
  /** Files in the library against files found on disk, and records still waiting for a file. */
  getLibraryProgress: async () => {
    const response = await apiFetch(`${API_BASE}/library/progress`);
    return libraryProgressSchema.parse(await handle<unknown>(response));
  },
  /** Adds and updates records from a backup file; nothing on this device is deleted. */
  importBackup: async (file: File) => {
    const body = new FormData();
    body.append('file', file);
    const response = await apiFetch(`${API_BASE}/backup`, { method: 'POST', body });
    return importResultSchema.parse(await handle<unknown>(response));
  },
  /** Takes over one account of an old GoonCave server from a copy of its database file. */
  importOldDatabase: async (input: { username: string; file: File }) => {
    const body = new FormData();
    body.append('username', input.username);
    body.append('file', input.file);
    const response = await apiFetch(`${API_BASE}/backup/old-database`, { method: 'POST', body });
    return importResultSchema.parse(await handle<unknown>(response));
  },
  getTaggingStatus: async () => {
    const response = await apiFetch(`${API_BASE}/tagging`);
    return taggingStatusSchema.parse(await handle<unknown>(response));
  },
  setTaggingEnabled: async (enabled: boolean) => {
    const response = await apiFetch(`${API_BASE}/tagging`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    return taggingStatusSchema.parse(await handle<unknown>(response));
  },
  getTagDatabaseStatus: async () => {
    const res = await apiFetch(`${API_BASE}/tags/database`);
    return tagDatabaseStatusSchema.parse(await handle<unknown>(res));
  },
  refreshTagDatabase: async () => {
    const res = await apiFetch(`${API_BASE}/tags/database`, { method: 'POST' });
    return z.object({ status: z.literal('queued') }).parse(await handle<unknown>(res));
  },
  getProviderDiagnostics: async () => {
    const res = await apiFetch(`${API_BASE}/settings/provider-diagnostics`);
    const data = await handle<unknown>(res);
    return z.object({ reports: z.array(providerDiagnosticSchema).max(200) }).parse(data).reports;
  },
  getDeviceProfile: async () => {
    const res = await apiFetch(`${API_BASE}/device`);
    const data = await handle<unknown>(res);
    return z.object({ user: z.object({
      id: z.string().min(1), username: z.string(), libraryRoot: z.string(),
      createdAt: z.string(), updatedAt: z.string(), lastLoginAt: z.null(),
      capabilities: z.object({ library: z.boolean(), boorus: z.boolean(), processing: z.boolean(), favorites: z.boolean().optional(), favoritesAutoSync: z.boolean().optional(), subscriptions: z.boolean().optional(), sourceMatching: z.boolean().optional(), tagging: z.boolean().optional(), duplicates: z.boolean().optional(), autoFavorite: z.boolean().optional(), tagRefresh: z.boolean().optional(), sync: z.boolean().optional(), browserSignIn: z.boolean().optional(), openFolder: z.boolean().optional() })
    }) }).parse(data).user;
  },
  getFileContentUrl: (fileId: string, options?: { download?: boolean }) => {
    const suffix = options?.download ? '?download=1' : '';
    return `${API_BASE}/files/${fileId}/content${suffix}`;
  },
  getFileContentBlob: async (
    fileId: string,
    options?: { signal?: AbortSignal; download?: boolean }
  ) => {
    const url = api.getFileContentUrl(fileId, { download: options?.download });
    const res = await apiFetch(
      url,
      options?.signal ? { signal: options.signal } : undefined
    );
    // `handle` throws on an error status: the readable message, and the
    // sign-in prompt on a 401.
    if (!res.ok) await handle(res);
    return res.blob();
  },
  getFolders: async (): Promise<Folder[]> => {
    const res = await apiFetch(`${API_BASE}/folders`);
    const data = await handle<FoldersResponse>(res);
    return data.folders;
  },
  /** Copies files into a library folder; files it refuses come back with the reason. */
  uploadFiles: async (folderId: string, files: File[]) => {
    const body = new FormData();
    for (const file of files) body.append('files', file);
    const res = await apiFetch(`${API_BASE}/folders/${folderId}/uploads`, { method: 'POST', body });
    return uploadResultSchema.parse(await handle<unknown>(res));
  },
  getFiles: async (
    sort?: 'mtime_desc' | 'mtime_asc' | 'random' | 'rated',
    tags?: string,
    options?: {
      limit?: number;
      offset?: number;
      seed?: string;
      mediaType?: 'IMAGE' | 'VIDEO';
      signal?: AbortSignal;
    }
  ): Promise<FilesResponse> => {
    const params = new URLSearchParams();
    if (sort) params.set('sort', sort);
    if (tags && tags.trim()) params.set('tags', tags.trim());
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    if (options?.seed) params.set('seed', options.seed);
    if (options?.mediaType) params.set('mediaType', options.mediaType);
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await apiFetch(
      `${API_BASE}/files${query}`,
      options?.signal ? { signal: options.signal } : undefined
    );
    const data = await handle<FilesResponse>(res);
    return data;
  },
  markRead: async (scope: 'post', keys: string[]) => {
    const res = await apiFetch(`${API_BASE}/read-marks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, keys })
    });
    return handle<{ marked: number }>(res);
  },
  clearRead: async (scope: 'post') => {
    const res = await apiFetch(`${API_BASE}/read-marks?scope=${scope}`, {
      method: 'DELETE'
    });
    return handle<{ cleared: number }>(res);
  },
  getProviders: async (fileId: string) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/providers`);
    return handle<ProvidersResponse>(res);
  },
  deleteFile: async (fileId: string) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}`, {
      method: 'DELETE'
    });
    return handle<{ status: string; errors?: string[] }>(res);
  },
  voteFile: async (fileId: string, value: 1 | -1) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/vote`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ value })
    });
    return handle<FileVoteResponse>(res);
  },
  runProvider: async (fileId: string, provider: 'saucenao' | 'fluffle') => {
    const res = await apiFetch(
      `${API_BASE}/files/${fileId}/providers/${provider}`,
      {
        method: 'POST'
      }
    );
    return handle<ProviderRunResponse>(res);
  },
  getSources: async () => {
    const res = await apiFetch(`${API_BASE}/sources`);
    return handle<SourceResponse>(res);
  },
  updateSourceSettings: async (settings: SourceSettings) => {
    const payload: {
      display: string[];
      targets: string[];
      displayInitialized?: boolean;
    } = {
      display: settings.display,
      targets: settings.targets
    };
    if (settings.displayInitialized !== undefined) {
      payload.displayInitialized = settings.displayInitialized;
    }
    const res = await apiFetch(`${API_BASE}/sources/settings`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(payload)
    });
    return handle<{ settings: SourceSettings; progress: SourceProgress }>(res);
  },
  syncFavorites: async (payload?: {
    providers?: string[];
    deleteMissing?: boolean;
  }) => {
    const res = await apiFetch(`${API_BASE}/favorites/sync`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload ?? {})
    });
    return handle<FavoriteSyncResponse>(res);
  },
  cancelFavoritesSync: async () => {
    const res = await apiFetch(`${API_BASE}/favorites/sync/cancel`, {
      method: 'POST'
    });
    return handle<{
      status: 'cancelling' | 'idle';
      state: FavoriteSyncStatus;
    }>(res);
  },
  getFavoritesSyncStatus: async () => {
    const res = await apiFetch(`${API_BASE}/favorites/sync/status`);
    return handle<FavoriteSyncStatus>(res);
  },
  getCredentials: async () => {
    const res = await apiFetch(`${API_BASE}/credentials`);
    const data = await handle<CredentialsResponse>(res);
    return data.credentials;
  },
  updateCredential: async (payload: {
    provider: CredentialProvider;
    username?: string;
    apiKey?: string;
  }) => {
    const res = await apiFetch(`${API_BASE}/credentials`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(payload)
    });
    const data = await handle<CredentialUpdateResponse>(res);
    return data.credential;
  },
  /** Title and description of the posts a local file was saved from. */
  getFileSourceText: async (fileId: string) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/source-text`);
    return handle<{ sources: FileSourceText[] }>(res);
  },
  getFileTags: async (fileId: string) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/tags`);
    return handle<TagsResponse>(res);
  },
  clearFileTags: async (fileId: string) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/tags`, {
      method: 'DELETE'
    });
    return handle<ClearTagsResponse>(res);
  },
  refreshFileTags: async (
    fileId: string,
    onStatus?: (status: FileTagRefreshStatus) => void
  ) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/tags/refresh`, {
      method: 'POST'
    });
    let { job } = await handle<FileTagRefreshResponse>(res);
    onStatus?.(job.status);
    while (job.status === 'queued' || job.status === 'running') {
      await new Promise((resolve) =>
        globalThis.setTimeout(resolve, FILE_TAG_REFRESH_POLL_MS)
      );
      const status = await apiFetch(
        `${API_BASE}/files/${fileId}/tags/refresh/${job.id}`
      );
      job = (await handle<FileTagRefreshResponse>(status)).job;
      onStatus?.(job.status);
    }
    if (job.status === 'error') {
      throw new Error(job.error ?? 'Tag refresh failed');
    }
    const refreshed = await apiFetch(`${API_BASE}/files/${fileId}/tags`);
    return handle<TagsResponse>(refreshed);
  },
  addManualTag: async (fileId: string, tag: string, category: string) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/tags/manual`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ tag, category })
    });
    return handle<{ status: string }>(res);
  },
  suppressFileTags: async (fileId: string, tags: string[]) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/tags/suppress`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ tags })
    });
    return handle<TagsResponse>(res);
  },
  getShortcuts: async () => {
    const res = await apiFetch(`${API_BASE}/settings/shortcuts`);
    return handle<ShortcutsResponse>(res);
  },
  updateShortcuts: async (bindings: Record<string, string>) => {
    const res = await apiFetch(`${API_BASE}/settings/shortcuts`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ bindings })
    });
    return handle<ShortcutsResponse>(res);
  },
  suggestTags: async (
    query: string,
    options?: {
      signal?: AbortSignal;
      /**
       * 'vocabulary' widens beyond the user's own files, for searches that
       * run against remote boorus rather than the library.
       */
      scope?: 'library' | 'vocabulary';
    }
  ) => {
    const params = new URLSearchParams({ q: query });
    if (options?.scope) params.set('scope', options.scope);
    const res = await apiFetch(
      `${API_BASE}/tags/suggest?${params.toString()}`,
      options?.signal ? { signal: options.signal } : undefined
    );
    return z.object({ suggestions: z.array(z.object({ tag: z.string().min(1), files: z.number().int().nonnegative() })).max(50) }).parse(await handle<unknown>(res));
  },
  explorePosts: async (params: {
    tags: string[];
    sort: ExploreSort;
    window: ExploreWindow;
    /** Any date inside the period to show, YYYY-MM-DD. */
    date?: string;
    siteIds?: string[];
    page: number;
    limit?: number;
    signal?: AbortSignal;
  }) => {
    const query = new URLSearchParams({
      tags: params.tags.join(' '),
      sort: params.sort,
      window: params.window,
      page: String(params.page)
    });
    if (params.date) query.set('date', params.date);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.siteIds) query.set('sites', params.siteIds.join(','));
    const res = await apiFetch(
      `${API_BASE}/explore/posts?${query.toString()}`,
      params.signal ? { signal: params.signal } : undefined
    );
    return handle<ExploreSearchResponse>(res);
  },
  exploreSubscriptions: async (params: {
    siteIds?: string[];
    cursor?: string;
    resume?: boolean;
    limit?: number;
    signal?: AbortSignal;
  }) => {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.siteIds) query.set('sites', params.siteIds.join(','));
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.resume) query.set('resume', '1');
    const res = await apiFetch(
      `${API_BASE}/explore/subscriptions?${query.toString()}`,
      params.signal ? { signal: params.signal } : undefined
    );
    return handle<SubscriptionFeedResponse>(res);
  },
  saveSubscriptionBookmark: async (post: { siteId: string; remoteId: string }) => {
    const res = await apiFetch(`${API_BASE}/explore/subscriptions/bookmark`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(post),
      keepalive: true
    });
    return handle<{ ok: boolean }>(res);
  },
  exploreGalleryMatches: async (
    posts: ExplorePost[],
    signal?: AbortSignal
  ) => {
    const res = await apiFetch(`${API_BASE}/explore/gallery-matches`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        posts: posts.flatMap((post) =>
          post.matchPreviewUrl
            ? [{
                key: `${post.siteId}:${post.remoteId}`,
                matchPreviewUrl: post.matchPreviewUrl,
                width: post.width,
                height: post.height,
                fileExt: post.fileExt
              }]
            : []
        )
      }),
      signal
    });
    return handle<{ keys: string[] }>(res);
  },
  refreshExploreSubscriptions: async (rounds = 1, signal?: AbortSignal) => {
    const res = await apiFetch(`${API_BASE}/explore/subscriptions/refresh`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ rounds }),
      signal
    });
    return handle<{ errors: ExploreSiteError[] }>(res);
  },
  exploreVote: async (payload: {
    siteId: string;
    remoteId: string;
    score: 1 | 0 | -1;
    previousScore?: 1 | -1;
  }) => {
    const res = await apiFetch(`${API_BASE}/explore/vote`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload)
    });
    return handle<{ ok: boolean }>(res);
  },
  exploreFavorite: async (payload: {
    siteId: string;
    remoteId: string;
    fileUrl?: string;
    autoVote?: boolean;
  }) => {
    const res = await apiFetch(`${API_BASE}/explore/favorite`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload)
    });
    return handle<{ ok: boolean; fileId: string | null; voteError: string | null }>(res);
  },
  /**
   * The tags of one post, with the category the booru filed each under.
   * Search results do not always carry them: gelbooru-style listings report
   * no category at all, so everything arrives as 'general' (issue #311).
   */
  /** Title and description of one explore post, on boorus that have them. */
  explorePostText: async (siteId: string, remoteId: string) => {
    const params = new URLSearchParams({ siteId, remoteId });
    const res = await apiFetch(
      `${API_BASE}/explore/post-text?${params.toString()}`
    );
    return handle<{ title: string | null; description: string | null }>(res);
  },
  exploreDetailTags: async (
    siteId: string,
    remoteId: string,
    signal?: AbortSignal
  ) => {
    const params = new URLSearchParams({ siteId, remoteId });
    const res = await apiFetch(
      `${API_BASE}/explore/post-tags?${params.toString()}`,
      signal ? { signal } : undefined
    );
    return handle<{
      tags: ExplorePost['tags'];
      fileUrl: string | null;
    }>(res);
  },
  /**
   * The parent and child posts of one post. The caller passes what the
   * search already told it, so a post standing alone never reaches a booru.
   */
  exploreRelations: async (
    post: Pick<ExplorePost, 'siteId' | 'remoteId' | 'parentId' | 'hasChildren'>,
    signal?: AbortSignal
  ) => {
    const params = new URLSearchParams({
      siteId: post.siteId,
      remoteId: post.remoteId,
      hasChildren: post.hasChildren ? 'true' : 'false'
    });
    if (post.parentId) params.set('parentId', post.parentId);
    const res = await apiFetch(
      `${API_BASE}/explore/post-relations?${params.toString()}`,
      signal ? { signal } : undefined
    );
    return handle<{ posts: RelatedPost[] }>(res);
  },
  /** The pools one explore post belongs to, with its neighbouring pages. */
  explorePostPools: async (
    post: Pick<ExplorePost, 'siteId' | 'remoteId' | 'poolIds'>,
    signal?: AbortSignal
  ) => {
    const params = new URLSearchParams({
      siteId: post.siteId,
      remoteId: post.remoteId
    });
    // Sent only when the booru actually answered: the parameter's absence is
    // what tells the server to go and look, and an empty one means "none".
    if (post.poolIds !== null) params.set('poolIds', post.poolIds.join(','));
    const res = await apiFetch(
      `${API_BASE}/explore/post-pools?${params.toString()}`,
      signal ? { signal } : undefined
    );
    return handle<{ pools: PoolNavigator[] }>(res);
  },
  /** The same, for a file already in the library. */
  filePools: async (fileId: string, signal?: AbortSignal) => {
    const res = await apiFetch(
      `${API_BASE}/files/${fileId}/pools`,
      signal ? { signal } : undefined
    );
    return handle<{ pools: PoolNavigator[] }>(res);
  },
  /** One post by id, for a caller holding nothing but the id. */
  explorePost: async (
    siteId: string,
    remoteId: string,
    signal?: AbortSignal
  ) => {
    const params = new URLSearchParams({ siteId, remoteId });
    const res = await apiFetch(
      `${API_BASE}/explore/post?${params.toString()}`,
      signal ? { signal } : undefined
    );
    return handle<{ post: LibraryAwarePost }>(res);
  },
  /** One page of a pool, in reading order. */
  poolPage: async (
    siteId: string,
    poolId: string,
    page: number,
    signal?: AbortSignal
  ) => {
    const params = new URLSearchParams({
      siteId,
      poolId,
      page: String(page)
    });
    const res = await apiFetch(
      `${API_BASE}/explore/pool?${params.toString()}`,
      signal ? { signal } : undefined
    );
    return handle<PoolPage>(res);
  },
  /** The same group, for a file already in the library. */
  fileRelations: async (fileId: string, signal?: AbortSignal) => {
    const res = await apiFetch(
      `${API_BASE}/files/${fileId}/relations`,
      signal ? { signal } : undefined
    );
    return handle<{ posts: RelatedPost[] }>(res);
  },
  exploreUnfavorite: async (payload: { siteId: string; remoteId: string }) => {
    const res = await apiFetch(`${API_BASE}/explore/unfavorite`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload)
    });
    return handle<{ ok: boolean; removedLocalFile: boolean }>(res);
  },
  startDuplicateScan: async (options?: DuplicateScanOptions) => {
    const { intent = 'manual', ...scanOptions } = options ?? {};
    const res = await apiFetch(`${API_BASE}/duplicates/scan/start`, {
      method: 'POST',
      headers: {
        ...jsonHeaders,
        'X-Duplicate-Scan-Intent': intent
      },
      body: JSON.stringify(scanOptions)
    });
    return handle<DuplicateScanStartResponse>(res);
  },
  getDuplicateScanStatus: async () => {
    const res = await apiFetch(`${API_BASE}/duplicates/scan/status`);
    return handle<DuplicateScanStatusResponse>(res);
  },
  cancelDuplicateScan: async () => {
    const res = await apiFetch(`${API_BASE}/duplicates/scan/cancel`, {
      method: 'POST'
    });
    return handle<{ status: string }>(res);
  },
  getDuplicateSettings: async () => {
    const res = await apiFetch(`${API_BASE}/duplicates/settings`);
    return handle<DuplicateSettingsResponse>(res);
  },
  updateDuplicateSettings: async (settings: { enabled: false }) => {
    const res = await apiFetch(`${API_BASE}/duplicates/settings`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(settings)
    });
    return handle<DuplicateSettingsResponse>(res);
  },
  previewDuplicatePolicy: async (input: {
    style: Exclude<DuplicateSettings['style'], null>;
    preferredProviders: string[];
  }) => {
    const res = await apiFetch(`${API_BASE}/duplicates/policy/preview`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(input)
    });
    return handle<DuplicatePolicyRun>(res);
  },
  confirmDuplicatePolicy: async (previewId: string) => {
    const res = await apiFetch(`${API_BASE}/duplicates/policy/confirm`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ previewId })
    });
    return handle<{ status: 'queued' }>(res);
  },
  getDuplicatePolicyStatus: async () => {
    const res = await apiFetch(`${API_BASE}/duplicates/policy/status`);
    return handle<{ latestRun: DuplicatePolicyRun | null; queued: boolean }>(res);
  },
  retryDuplicatePolicy: async () => {
    const res = await apiFetch(`${API_BASE}/duplicates/policy/retry`, {
      method: 'POST'
    });
    return handle<{ status: 'queued' }>(res);
  },
  getExtraSettings: async () => {
    const res = await apiFetch(`${API_BASE}/settings/extra`);
    return handle<ExtraSettings>(res);
  },
  getBlacklist: async () => {
    const res = await apiFetch(`${API_BASE}/settings/blacklist`);
    return handle<BlacklistSettings>(res);
  },
  getSubscriptions: async () => {
    const res = await apiFetch(`${API_BASE}/settings/subscriptions`);
    return handle<SubscriptionSettings>(res);
  },
  getSubscriptionTags: async () => {
    const res = await apiFetch(`${API_BASE}/settings/subscriptions/tags`);
    return handle<{ tags: string[] }>(res);
  },
  updateSubscriptionTags: async (tags: string[]) => {
    const res = await apiFetch(`${API_BASE}/settings/subscriptions/tags`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ tags })
    });
    return handle<{ tags: string[] }>(res);
  },
  addSubscriptionTag: async (tag: string) => {
    const res = await apiFetch(`${API_BASE}/settings/subscriptions/tags`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ tag })
    });
    return handle<{ tags: string[] }>(res);
  },
  getSubscriptionPools: async () => {
    const res = await apiFetch(`${API_BASE}/settings/subscriptions/pools`);
    return handle<{ pools: PoolSubscription[] }>(res);
  },
  subscribePool: async (siteId: string, poolId: string) => {
    const res = await apiFetch(`${API_BASE}/settings/subscriptions/pools`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ siteId, poolId })
    });
    return handle<{ pools: PoolSubscription[] }>(res);
  },
  unsubscribePool: async (siteId: string, poolId: string) => {
    const res = await apiFetch(`${API_BASE}/settings/subscriptions/pools`, {
      method: 'DELETE',
      headers: jsonHeaders,
      body: JSON.stringify({ siteId, poolId })
    });
    return handle<{ pools: PoolSubscription[] }>(res);
  },
  subscribeArtist: async (siteId: string, artist: string) => {
    const res = await apiFetch(`${API_BASE}/settings/subscriptions/artists`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ siteId, artist })
    });
    return handle<{ ok: boolean }>(res);
  },
  unsubscribeArtist: async (siteId: string, artist: string) => {
    const res = await apiFetch(`${API_BASE}/settings/subscriptions/artists`, {
      method: 'DELETE',
      headers: jsonHeaders,
      body: JSON.stringify({ siteId, artist })
    });
    return handle<{ ok: boolean }>(res);
  },
  updateBlacklist: async (patch: Partial<BlacklistSettings>) => {
    const res = await apiFetch(`${API_BASE}/settings/blacklist`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(patch)
    });
    return handle<BlacklistSettings>(res);
  },
  updateExtraSettings: async (settings: Partial<ExtraSettings>) => {
    const res = await apiFetch(`${API_BASE}/settings/extra`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(settings)
    });
    return handle<ExtraSettings>(res);
  },
  getBooruSites: async () => {
    const res = await apiFetch(`${API_BASE}/booru-sites`);
    const data = await handle<{ sites: BooruSite[] }>(res);
    return data.sites;
  },
  getBooruEngineCatalog: async () => {
    const res = await apiFetch(`${API_BASE}/booru-sites/engines`);
    return handle<BooruEngineCatalog>(res);
  },
  detectBooruEngine: async (baseUrl: string) => {
    const res = await apiFetch(`${API_BASE}/booru-sites/detect`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ baseUrl })
    });
    if (res.status === 422 || res.status === 502) {
      return (await res.json()) as BooruDetectionResult;
    }
    return handle<BooruDetectionResult>(res);
  },
  createBooruSite: async (payload: {
    name: string;
    engine: BooruEngineType;
    baseUrl: string;
    username?: string | null;
    apiKey?: string | null;
    sessionCookie?: string | null;
    siteAutoSyncMidnight?: boolean;
    siteReverseSyncEnabled?: boolean;
    siteAutoFavEnabled?: boolean;
    enabled?: boolean;
  }) => {
    const res = await apiFetch(`${API_BASE}/booru-sites`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload)
    });
    const data = await handle<{ site: BooruSite }>(res);
    return data.site;
  },
  updateBooruSite: async (
    id: string,
    payload: Partial<{
      name: string;
      username: string | null;
      apiKey: string | null;
      sessionCookie: string | null;
      enabled: boolean;
      siteAutoSyncMidnight: boolean;
      siteReverseSyncEnabled: boolean;
      siteAutoFavEnabled: boolean;
      engine: BooruEngineType;
      baseUrl: string;
    }>
  ) => {
    const res = await apiFetch(`${API_BASE}/booru-sites/${id}`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(payload)
    });
    const data = await handle<{ site: BooruSite }>(res);
    return data.site;
  },
  deleteBooruSite: async (id: string) => {
    const res = await apiFetch(`${API_BASE}/booru-sites/${id}`, {
      method: 'DELETE'
    });
    return handle<{ ok: boolean }>(res);
  },
  refreshBooruSiteTags: async (id: string) => {
    const res = await apiFetch(`${API_BASE}/booru-sites/${id}/tags/refresh`, {
      method: 'POST'
    });
    return handle<{ status: 'started' | 'busy'; progress: TagRefreshProgress }>(
      res
    );
  },
  getBooruTagRefresh: async () => {
    const res = await apiFetch(`${API_BASE}/booru-sites/tags/refresh`);
    return handle<TagRefreshProgress>(res);
  },
  cancelBooruTagRefresh: async () => {
    const res = await apiFetch(`${API_BASE}/booru-sites/tags/refresh/cancel`, {
      method: 'POST'
    });
    return handle<{ cancelled: boolean }>(res);
  },
  /** Opens the desktop app's sign-in window; null fields mean the window was closed. */
  signInBooruSite: async (id: string) => {
    const res = await apiFetch(`${API_BASE}/booru-sites/${id}/sign-in`, {
      method: 'POST'
    });
    return handle<{ sessionCookie: string | null; username: string | null }>(
      res
    );
  },
  testBooruSite: async (id: string) => {
    const res = await apiFetch(`${API_BASE}/booru-sites/${id}/test`, {
      method: 'POST'
    });
    return handle<{
      ok: boolean;
      status?: number;
      error?: string;
      cookie?: { ok: boolean; error?: string };
    }>(res);
  },
  reorderBooruSites: async (orderedIds: string[]) => {
    const res = await apiFetch(`${API_BASE}/booru-sites/reorder`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ orderedIds })
    });
    const data = await handle<{ sites: BooruSite[] }>(res);
    return data.sites;
  }
};
