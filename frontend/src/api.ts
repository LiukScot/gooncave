const resolveApiBase = () => {
  const envBase = import.meta.env.VITE_API_BASE_URL;
  if (envBase && envBase.length > 0) return envBase;
  if (import.meta.env.DEV) return 'http://localhost:4100';
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
  isFavorite: boolean;
  providers?: Partial<Record<'SAUCENAO' | 'FLUFFLE', ProviderRun>>;
  createdAt: string;
  updatedAt: string;
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

export type FileTag = {
  tag: string;
  category: string;
  source:
    | 'E621'
    | 'DANBOORU'
    | 'GELBOORU'
    | 'YANDERE'
    | 'KONACHAN'
    | 'SANKAKU'
    | 'IDOL_COMPLEX'
    | 'WD14'
    | 'MANUAL';
  score: number | null;
  sourceUrl: string | null;
};

type FoldersResponse = { folders: Folder[] };
type DeleteResponse = { status: string; error?: string };
export type FolderUploadItem = { name: string; fileId?: string | null; reason?: string };
export type FolderUploadResult = { uploaded: FolderUploadItem[]; rejected: FolderUploadItem[] };
export type FolderUploadProgress = { loaded: number; total: number | null; percent: number };
type FilesResponse = { files: FileItem[]; total?: number };
type SauceResponse = { sources: SauceSource[]; settings: SauceSettings; progress: SauceProgress };
type TagsResponse = { tags: FileTag[] };
type ProviderRun = {
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
type RemoveMatchResponse = { status: string; tags: FileTag[]; providers: ProviderRun[] };
type DuplicateScanResponse = DuplicateScanResult;
type DuplicateScanStartResponse = { status: 'started' | 'busy'; state: DuplicateScanStatus };
type DuplicateScanStatusResponse = DuplicateScanStatus;
type DuplicateSettingsResponse = DuplicateSettings;
type ClearTagsResponse = { status: string; removed: number };
type FileFavoriteResponse = { status: string; isFavorite: boolean };
type FavoriteSyncResult = {
  provider: 'E621' | 'DANBOORU';
  fetched: number;
  added: number;
  removed: number;
  skipped: number;
  errors: string[];
};
type FavoriteSyncProgress = {
  provider: 'E621' | 'DANBOORU';
  stage: 'idle' | 'fetching' | 'downloading' | 'deleting' | 'done' | 'error';
  fetched: number;
  total: number;
  processed: number;
  added: number;
  removed: number;
  skipped: number;
  errors: string[];
};
type FavoriteSyncStatus = {
  status: 'idle' | 'running' | 'done' | 'error';
  message: string;
  startedAt: string | null;
  updatedAt: string;
  progress: { providers: FavoriteSyncProgress[] } | null;
  results: FavoriteSyncResult[];
};
type FavoritesSettings = { reverseSyncEnabled: boolean; autoSyncMidnight: boolean; favoritesRootId: string | null };
type FavoriteSyncResponse = { status: 'started' | 'busy'; state: FavoriteSyncStatus };
type CredentialsResponse = { credentials: CredentialSummary[] };
type CredentialUpdateResponse = { credential: CredentialSummary };
type AuthResponse = { user: AuthUser };

const jsonHeaders = { 'Content-Type': 'application/json' };

const extractErrorMessage = (text: string, fallback: string) => {
  let message = text || fallback;
  if (text) {
    try {
      const parsed = JSON.parse(text) as { error?: string; issues?: Array<{ message?: string }> };
      const firstIssue = parsed?.issues?.find((issue) => issue?.message)?.message;
      const parsedMessage = firstIssue || parsed?.error;
      if (parsedMessage) {
        message = parsedMessage;
      }
    } catch {
      // Fall back to raw text for non-JSON responses.
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
  getFileContentBlob: async (fileId: string, options?: { signal?: AbortSignal; download?: boolean }) => {
    const url = api.getFileContentUrl(fileId, { download: options?.download });
    const res = await apiFetch(url, options?.signal ? { signal: options.signal } : undefined);
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
        const percent = total && total > 0 ? Math.min(100, Math.round((event.loaded / total) * 100)) : 0;
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
          reject(new Error(extractErrorMessage(responseText, xhr.statusText || 'Upload failed')));
          return;
        }
        try {
          const parsed = responseText ? (JSON.parse(responseText) as Partial<FolderUploadResult>) : {};
          if ((parsed.uploaded !== undefined && !Array.isArray(parsed.uploaded)) || (parsed.rejected !== undefined && !Array.isArray(parsed.rejected))) {
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
    sort?: 'mtime_desc' | 'mtime_asc' | 'random' | 'manual',
    tags?: string,
    options?: {
      limit?: number;
      offset?: number;
      seed?: string;
      mediaType?: 'IMAGE' | 'VIDEO';
      favoritesOnly?: boolean;
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
    if (options?.favoritesOnly) params.set('favorites', 'true');
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await apiFetch(`${API_BASE}/files${query}`, options?.signal ? { signal: options.signal } : undefined);
    const data = await handle<FilesResponse>(res);
    return data;
  },
  getProviders: async (fileId: string) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/providers`);
    return handle<ProvidersResponse>(res);
  },
  deleteFile: async (fileId: string) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}`, { method: 'DELETE' });
    return handle<{ status: string; errors?: string[] }>(res);
  },
  updateFileFavorite: async (fileId: string, favorite: boolean) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/favorite`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ favorite })
    });
    return handle<FileFavoriteResponse>(res);
  },
  runProvider: async (fileId: string, provider: 'saucenao' | 'fluffle') => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/providers/${provider}`, {
      method: 'POST'
    });
    return handle<ProviderRunResponse>(res);
  },
  getSauces: async () => {
    const res = await apiFetch(`${API_BASE}/sauces`);
    return handle<SauceResponse>(res);
  },
  updateSauceSettings: async (settings: SauceSettings) => {
    const payload: { display: string[]; targets: string[]; displayInitialized?: boolean } = {
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
  updateManualOrder: async (order: string[]) => {
    const res = await apiFetch(`${API_BASE}/files/manual-order`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ order })
    });
    return handle<{ status: string; saved: number }>(res);
  },
  syncFavorites: async (payload?: { providers?: ('E621' | 'DANBOORU')[]; deleteMissing?: boolean }) => {
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
  updateCredential: async (payload: { provider: CredentialProvider; username?: string; apiKey?: string }) => {
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
  removeManualTag: async (fileId: string, tag: string, category: string) => {
    const res = await apiFetch(`${API_BASE}/files/${fileId}/tags/manual`, {
      method: 'DELETE',
      headers: jsonHeaders,
      body: JSON.stringify({ tag, category })
    });
    return handle<{ status: string }>(res);
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
    const res = await apiFetch(`${API_BASE}/duplicates/scan/cancel`, { method: 'POST' });
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
  }
};
