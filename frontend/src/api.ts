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
export const authRequiredEvent = 'gooncave:auth-required';

const apiFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  return fetch(input, {
    ...init,
    credentials: 'include'
  });
};

const notifyAuthRequired = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(authRequiredEvent));
};

export type AuthUser = {
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
  locationType: 'LOCAL';
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
  createdAt: string;
  updatedAt: string;
};

export type ExtraSettings = {
  gamesTabEnabled: boolean;
  voteSystemEnabled: boolean;
};

/**
 * Mirrors the backend defaults, used while the real settings are still in
 * flight so nothing flickers out of the UI on first paint.
 */
export const EXTRA_SETTINGS_DEFAULTS: ExtraSettings = {
  gamesTabEnabled: true,
  voteSystemEnabled: true
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

export type DuplicateFile = {
  id: string;
  folderId: string;
  path: string;
  mediaType: 'IMAGE' | 'VIDEO';
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbUrl: string | null;
  favoriteProviders?: ('E621' | 'DANBOORU')[];
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
  autoResolve: boolean;
};

export type DuplicateScanOptions = {
  mediaType?: 'IMAGE' | 'VIDEO' | 'ALL';
  pixelThreshold?: number;
  sampleSize?: number;
  videoFrames?: number;
  maxComparisons?: number;
};

export type SauceSource = {
  key: string;
  label: string;
  count: number;
};

export type SauceSettings = {
  display: string[];
  targets: string[];
  displayInitialized?: boolean;
};

export type SauceProgress = {
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
  | 'szurubooru';

export type BooruCredentialSchema =
  'username+apikey' | 'userid+apikey' | 'apikey-only' | 'token' | 'none';

export type BooruEngineCapabilities = {
  favorites: boolean;
  tags: boolean;
  sourceMatch: boolean;
  search: boolean;
  vote: boolean;
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
    supportsSessionCookie: boolean;
  }>;
  presets: Array<{
    key: string;
    name: string;
    engine: BooruEngineType;
    baseUrl: string;
  }>;
};

type FoldersResponse = { folders: Folder[] };
type DeleteResponse = { status: string; error?: string };
type FolderUploadItem = {
  name: string;
  fileId?: string | null;
  reason?: string;
};
type FolderUploadResult = {
  uploaded: FolderUploadItem[];
  rejected: FolderUploadItem[];
};
type FolderUploadProgress = {
  loaded: number;
  total: number | null;
  percent: number;
};
type FilesResponse = { files: FileItem[]; total?: number };
type SauceResponse = {
  sources: SauceSource[];
  settings: SauceSettings;
  progress: SauceProgress;
};
type TagsResponse = {
  tags: FileTag[];
  /** Tags the stored ones imply, derived server-side and never stored. */
  implied: string[];
};

export type TagAlias = {
  antecedent: string;
  consequent: string;
  source: 'e621' | 'custom';
};

export type TagDatabaseStatus = {
  importedAt: string | null;
  aliases: number;
  implications: number;
  customAliases: number;
};

type TagAliasesResponse = { aliases: TagAlias[] };

export type TagSuggestion = { tag: string; files: number };

type ShortcutsResponse = { bindings: Record<string, string> };

type TagSuggestionsResponse = { suggestions: TagSuggestion[] };

/** 'subscribed' is a placeholder tab: the backend never sees it. */
export type ExploreSort = 'new' | 'hot' | 'popular' | 'subscribed';
export type ExploreWindow = 'day' | 'week' | 'month';

export type ExplorePost = {
  remoteId: string;
  previewUrl: string | null;
  sampleUrl: string | null;
  fileUrl: string | null;
  width: number | null;
  height: number | null;
  score: number | null;
  rating: string | null;
  md5: string | null;
  createdAt: string | null;
  tags: { tag: string; category: string }[];
  favCount: number | null;
  uploader: string | null;
  fileExt: string | null;
  fileSize: number | null;
  /** Already in the user's favorites, per the booru or the local library. */
  favorited: boolean;
  /** The vote already cast on the booru: 1, -1, 0 for none, null if unknown. */
  voted: 1 | -1 | 0 | null;
  siteId: string;
  siteName: string;
  engine: BooruEngineType;
  sourceUrl: string;
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
type RemoveMatchResponse = {
  status: string;
  tags: FileTag[];
  implied: string[];
  providers: ProviderRun[];
};
type DuplicateScanResponse = DuplicateScanResult;
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
  fetched: number;
  added: number;
  removed: number;
  skipped: number;
  errors: string[];
};
type FavoriteSyncProgress = {
  provider: string;
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
type FavoritesSettings = { favoritesRootId: string | null };
type FavoriteSyncResponse = {
  status: 'started' | 'busy';
  state: FavoriteSyncStatus;
};
type CredentialsResponse = { credentials: CredentialSummary[] };
type CredentialUpdateResponse = { credential: CredentialSummary };
type AuthResponse = { user: AuthUser };

const jsonHeaders = { 'Content-Type': 'application/json' };

export const extractErrorMessage = (text: string, fallback: string) => {
  let message = text || fallback;
  if (text) {
    try {
      const parsed = JSON.parse(text) as {
        error?: string;
        issues?: Array<{ message?: string }>;
      };
      const firstIssue = parsed?.issues?.find(
        (issue) => issue?.message
      )?.message;
      const parsedMessage = firstIssue || parsed?.error;
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

const handle = async <T>(res: Response): Promise<T> => {
  if (!res.ok) {
    const text = await res.text();
    const message = extractErrorMessage(text, res.statusText);
    const error = new Error(message) as Error & { status?: number };
    error.status = res.status;
    if (res.status === 401) {
      notifyAuthRequired();
    }
    throw error;
  }
  return res.json() as Promise<T>;
};

export const api = {
  getCurrentUser: async () => {
    const res = await apiFetch(`${API_BASE}/auth/me`);
    const data = await handle<AuthResponse>(res);
    return data.user;
  },
  register: async (payload: { username: string; password: string }) => {
    const res = await apiFetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload)
    });
    const data = await handle<AuthResponse>(res);
    return data.user;
  },
  login: async (payload: { username: string; password: string }) => {
    const res = await apiFetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload)
    });
    const data = await handle<AuthResponse>(res);
    return data.user;
  },
  logout: async () => {
    const res = await apiFetch(`${API_BASE}/auth/logout`, { method: 'POST' });
    return handle<{ status: string }>(res);
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
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || res.statusText);
    }
    return res.blob();
  },
  getFolders: async (): Promise<Folder[]> => {
    const res = await apiFetch(`${API_BASE}/folders`);
    const data = await handle<FoldersResponse>(res);
    return data.folders;
  },
  deleteFolder: async (id: string): Promise<DeleteResponse> => {
    const res = await apiFetch(`${API_BASE}/folders/${id}`, {
      method: 'DELETE'
    });
    return handle<DeleteResponse>(res);
  },
  uploadFolderFiles: async (
    folderId: string,
    files: File[],
    options?: { onProgress?: (progress: FolderUploadProgress) => void }
  ): Promise<FolderUploadResult> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/folders/${folderId}/uploads`);
      xhr.withCredentials = true;
      xhr.responseType = 'text';
      xhr.upload.onprogress = (event) => {
        const total = event.lengthComputable ? event.total : null;
        const percent =
          total && total > 0
            ? Math.min(100, Math.round((event.loaded / total) * 100))
            : 0;
        options?.onProgress?.({ loaded: event.loaded, total, percent });
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.onabort = () => reject(new Error('Upload aborted'));
      xhr.onload = () => {
        const responseText = xhr.responseText ?? '';
        if (xhr.status < 200 || xhr.status >= 300) {
          if (xhr.status === 401) {
            notifyAuthRequired();
          }
          reject(
            new Error(
              extractErrorMessage(
                responseText,
                xhr.statusText || 'Upload failed'
              )
            )
          );
          return;
        }
        try {
          const parsed = responseText
            ? (JSON.parse(responseText) as Partial<FolderUploadResult>)
            : {};
          if (
            (parsed.uploaded !== undefined &&
              !Array.isArray(parsed.uploaded)) ||
            (parsed.rejected !== undefined && !Array.isArray(parsed.rejected))
          ) {
            reject(new Error('Invalid upload response shape'));
            return;
          }
          resolve({
            uploaded: parsed.uploaded ?? [],
            rejected: parsed.rejected ?? []
          });
        } catch {
          reject(new Error('Invalid upload response'));
        }
      };

      const formData = new FormData();
      files.forEach((file) => {
        formData.append('files', file, file.name);
      });
      xhr.send(formData);
    });
  },
  getFiles: async (
    folderId?: string,
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
    if (folderId) params.set('folderId', folderId);
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
  getSauces: async () => {
    const res = await apiFetch(`${API_BASE}/sauces`);
    return handle<SauceResponse>(res);
  },
  updateSauceSettings: async (settings: SauceSettings) => {
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
    const res = await apiFetch(`${API_BASE}/sauces/settings`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(payload)
    });
    return handle<{ settings: SauceSettings; progress: SauceProgress }>(res);
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
  getFavoritesSettings: async () => {
    const res = await apiFetch(`${API_BASE}/favorites/settings`);
    return handle<FavoritesSettings>(res);
  },
  updateFavoritesSettings: async (settings: Partial<FavoritesSettings>) => {
    const res = await apiFetch(`${API_BASE}/favorites/settings`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(settings)
    });
    return handle<FavoritesSettings>(res);
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
  refreshFileTags: async (fileId: string) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/tags/refresh`, {
      method: 'POST'
    });
    return handle<TagsResponse>(res);
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
    return handle<TagSuggestionsResponse>(res);
  },
  explorePosts: async (params: {
    tags: string[];
    sort: Exclude<ExploreSort, 'subscribed'>;
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
  exploreVote: async (payload: {
    siteId: string;
    remoteId: string;
    score: 1 | -1;
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
    fileUrl: string;
  }) => {
    const res = await apiFetch(`${API_BASE}/explore/favorite`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload)
    });
    return handle<{ ok: boolean; fileId: string | null }>(res);
  },
  exploreUnfavorite: async (payload: { siteId: string; remoteId: string }) => {
    const res = await apiFetch(`${API_BASE}/explore/unfavorite`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(payload)
    });
    return handle<{ ok: boolean; removedLocalFile: boolean }>(res);
  },
  getTagDatabase: async () => {
    const res = await apiFetch(`${API_BASE}/tags/database`);
    return handle<TagDatabaseStatus>(res);
  },
  refreshTagDatabase: async () => {
    const res = await apiFetch(`${API_BASE}/tags/database/refresh`, {
      method: 'POST'
    });
    return handle<TagDatabaseStatus>(res);
  },
  getTagAliases: async () => {
    const res = await apiFetch(`${API_BASE}/tags/aliases`);
    return handle<TagAliasesResponse>(res);
  },
  addTagAlias: async (antecedent: string, consequent: string) => {
    const res = await apiFetch(`${API_BASE}/tags/aliases`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ antecedent, consequent })
    });
    return handle<TagAliasesResponse>(res);
  },
  removeTagAlias: async (antecedent: string) => {
    const res = await apiFetch(
      `${API_BASE}/tags/aliases/${encodeURIComponent(antecedent)}`,
      { method: 'DELETE' }
    );
    return handle<TagAliasesResponse>(res);
  },
  removeTopMatch: async (fileId: string, sourceUrl: string) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/matches/remove`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sourceUrl })
    });
    return handle<RemoveMatchResponse>(res);
  },
  scanDuplicates: async (options?: DuplicateScanOptions) => {
    const res = await apiFetch(`${API_BASE}/duplicates/scan`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(options ?? {})
    });
    return handle<DuplicateScanResponse>(res);
  },
  startDuplicateScan: async (options?: DuplicateScanOptions) => {
    const res = await apiFetch(`${API_BASE}/duplicates/scan/start`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(options ?? {})
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
  updateDuplicateSettings: async (settings: Partial<DuplicateSettings>) => {
    const res = await apiFetch(`${API_BASE}/duplicates/settings`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(settings)
    });
    return handle<DuplicateSettingsResponse>(res);
  },
  getExtraSettings: async () => {
    const res = await apiFetch(`${API_BASE}/settings/extra`);
    return handle<ExtraSettings>(res);
  },
  getBlacklist: async () => {
    const res = await apiFetch(`${API_BASE}/settings/blacklist`);
    return handle<BlacklistSettings>(res);
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
