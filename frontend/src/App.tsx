import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from 'react';

import {
  api,
  API_BASE,
  authRequiredEvent,
  AuthUser,
  DuplicateFile,
  DuplicateGroup,
  DuplicateScanOptions,
  DuplicateScanStats,
  DuplicateSettings,
  FileItem,
  FileTag,
  Folder,
  SauceProgress,
  SauceSettings,
  SauceSource
} from './api';
import type { CredentialProvider, CredentialSummary, DuplicateScanStatus } from './api';

type FetchState = {
  loading: boolean;
  error: string | null;
};

type GallerySort = 'manual' | 'mtime_desc' | 'mtime_asc' | 'random';

const gallerySortStorageKey = 'imagesearch.gallerySort';
const makeRandomSeed = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const formatDateTime = (value: string | null | undefined) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const basenameFromPath = (value: string) => {
  if (!value) return '';
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
};

const fileTypeFromPath = (value: string, mediaType: FileItem['mediaType']) => {
  const name = basenameFromPath(value);
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex > 0 && dotIndex < name.length - 1) {
    return name.slice(dotIndex + 1).toUpperCase();
  }
  return mediaType === 'VIDEO' ? 'VIDEO' : 'IMAGE';
};

const formatSizeMb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const guessMimeType = (filename: string, mediaType: FileItem['mediaType']) => {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return mediaType === 'VIDEO' ? 'video/*' : 'image/*';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webm: 'video/webm',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska'
  };
  return map[ext] ?? 'application/octet-stream';
};

const triggerDownload = (url: string, filename: string) => {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
};

const resolveArea = (file: DuplicateFile) => (file.width ?? 0) * (file.height ?? 0);

const pickNextFileAfterDelete = (files: FileItem[], currentId: string) => {
  const index = files.findIndex((file) => file.id === currentId);
  if (index === -1) return null;
  return files[index + 1] ?? files[index - 1] ?? null;
};

const favoriteProviderPriority = ['E621', 'DANBOORU'] as const;

const resolveFavoriteRank = (file: DuplicateFile) => {
  const providers = file.favoriteProviders ?? [];
  let rank = 0;
  favoriteProviderPriority.forEach((provider, index) => {
    if (providers.includes(provider)) {
      rank = Math.max(rank, favoriteProviderPriority.length - index);
    }
  });
  return rank;
};

const resolveFavoriteLabel = (file: DuplicateFile) => {
  const providers = file.favoriteProviders ?? [];
  if (!providers.length) return null;
  return providers.map((provider) => provider.toLowerCase()).join(', ');
};

const resolveFavoriteOverlap = (a: DuplicateFile, b: DuplicateFile) => {
  const providersA = a.favoriteProviders ?? [];
  const providersB = b.favoriteProviders ?? [];
  if (!providersA.length || !providersB.length) return true;
  return providersA.some((provider) => providersB.includes(provider));
};

const compareDuplicateQuality = (a: DuplicateFile, b: DuplicateFile) => {
  const areaA = resolveArea(a);
  const areaB = resolveArea(b);
  if (areaA !== areaB) return areaB - areaA;
  if (a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes;
  return a.path.localeCompare(b.path);
};

const compareDuplicatePreference = (a: DuplicateFile, b: DuplicateFile) => {
  const rankA = resolveFavoriteRank(a);
  const rankB = resolveFavoriteRank(b);
  if (rankA !== rankB) return rankB - rankA;
  return compareDuplicateQuality(a, b);
};

const pickDuplicateSuggestion = (a: DuplicateFile, b: DuplicateFile) => {
  const conflict =
    (a.favoriteProviders?.length ?? 0) > 0 &&
    (b.favoriteProviders?.length ?? 0) > 0 &&
    !resolveFavoriteOverlap(a, b);
  if (conflict) {
    return {
      keepId: null,
      reason: 'favorites from different sources (keep both)'
    };
  }
  const rankA = resolveFavoriteRank(a);
  const rankB = resolveFavoriteRank(b);
  if (rankA !== rankB) {
    const winner = rankA > rankB ? a : b;
    const winnerLabel = resolveFavoriteLabel(winner);
    if (rankA > 0 && rankB > 0) {
      return {
        id: winner.id,
        reason: `preferred favorite source (${winnerLabel ?? 'favorite'})`
      };
    }
    return {
      keepId: winner.id,
      reason: `synced favorite (${winnerLabel ?? 'favorite'})`
    };
  }
  const areaA = resolveArea(a);
  const areaB = resolveArea(b);
  if (areaA !== areaB) {
    return {
      keepId: areaA > areaB ? a.id : b.id,
      reason: 'larger resolution'
    };
  }
  if (a.sizeBytes !== b.sizeBytes) {
    return {
      keepId: a.sizeBytes > b.sizeBytes ? a.id : b.id,
      reason: 'larger file size'
    };
  }
  const label = resolveFavoriteLabel(a);
  if (label) {
    return { keepId: a.id, reason: `same resolution & size (${label})` };
  }
  return { keepId: a.id, reason: 'same resolution & size' };
};

const toNumberOr = (value: string, fallback: number) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const statusBadge = (status: string) => {
  switch (status) {
    case 'COMPLETED':
    case 'IDLE':
      return 'bg-success';
    case 'RUNNING':
    case 'SCANNING':
      return 'bg-warning text-dark';
    case 'FAILED':
      return 'bg-danger';
    default:
      return 'bg-secondary';
  }
};

const normalizeSauceKey = (value: string) => value.trim().toLowerCase();
const canonicalSauces: Record<string, string> = {
  'e621.net': 'e621',
  'www.e621.net': 'e621',
  'static1.e621.net': 'e621',
  'static2.e621.net': 'e621',
  'static3.e621.net': 'e621',
  'static4.e621.net': 'e621',
  'danbooru.donmai.us': 'danbooru',
  'www.danbooru.donmai.us': 'danbooru'
};

const canonicalizeSauceKey = (value: string) => {
  const key = normalizeSauceKey(value);
  if (canonicalSauces[key]) return canonicalSauces[key];
  if (key.endsWith('.e621.net')) return 'e621';
  return key;
};

const normalizeSourceName = (value: string) => {
  let cleaned = value.trim();
  if (!cleaned) return '';
  cleaned = cleaned.replace(/^index\s*#?\d+:\s*/i, '');
  cleaned = cleaned.replace(/\s+–\s+/g, ' - ');
  if (cleaned.includes(' - ')) {
    cleaned = cleaned.split(' - ')[0].trim();
  }
  return cleaned;
};

const looksLikeFilename = (value: string) => {
  if (!value) return false;
  const lower = value.toLowerCase();
  if (lower.includes('/') || lower.includes('\\')) return true;
  return /\.[a-z0-9]{2,5}$/.test(lower);
};

const sauceKeyFromResult = (sourceUrl: string | null | undefined, sourceName: string | null | undefined) => {
  if (sourceName) {
    const cleaned = normalizeSourceName(sourceName);
    if (cleaned && !looksLikeFilename(cleaned)) {
      return canonicalizeSauceKey(cleaned);
    }
  }
  if (sourceUrl) {
    try {
      return canonicalizeSauceKey(new URL(sourceUrl).hostname.replace(/^www\./, ''));
    } catch {
      return canonicalizeSauceKey(sourceUrl);
    }
  }
  return null;
};

const providerKinds = ['SAUCENAO', 'FLUFFLE'] as const;
type ProviderKind = (typeof providerKinds)[number];
const providerScoreThresholds: Record<ProviderKind, number> = {
  SAUCENAO: 90,
  FLUFFLE: 95
};
const showProviderRunButtons = false;

const isCredentialReady = (provider: CredentialProvider, credential: CredentialSummary | undefined) => {
  if (!credential) return false;
  if (provider === 'SAUCENAO') return credential.hasApiKey;
  return Boolean(credential.username) && credential.hasApiKey;
};

const isGallerySort = (value: string | null): value is GallerySort =>
  value === 'manual' || value === 'mtime_desc' || value === 'mtime_asc' || value === 'random';

type FavoriteSyncStatus = {
  status: 'idle' | 'running' | 'done' | 'error';
  message: string;
  startedAt: string | null;
  updatedAt: string;
  progress: {
    providers: {
      provider: 'E621' | 'DANBOORU';
      stage: 'idle' | 'fetching' | 'downloading' | 'deleting' | 'done' | 'error';
      fetched: number;
      total: number;
      processed: number;
      added: number;
      removed: number;
      skipped: number;
      errors: string[];
    }[];
  } | null;
  results: {
    provider: 'E621' | 'DANBOORU';
    fetched: number;
    added: number;
    removed: number;
    skipped: number;
    errors: string[];
  }[];
};

const emptySauceProgress: SauceProgress = {
  total: 0,
  matched: 0,
  failed: 0,
  pending: 0,
  videos: 0,
  failedImages: 0
};

const resolveProviderScore = (
  provider: ProviderKind,
  result: { score?: number | null; distance?: number | null }
) => {
  if (provider !== 'FLUFFLE') {
    return typeof result.score === 'number' ? result.score : null;
  }
  if (typeof result.score === 'number') {
    return result.score;
  }
  if (typeof result.distance === 'number') {
    return result.distance;
  }
  return null;
};

const formatRemaining = (ms: number) => {
  if (ms <= 0) return 'due now';
  const totalSeconds = Math.ceil(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 && parts.length < 2) parts.push(`${hours}h`);
  if (days === 0 && minutes > 0 && parts.length < 2) parts.push(`${minutes}m`);
  if (parts.length === 0) return 'under 1m';
  return `in ${parts.join(' ')}`;
};

type ViewMode = 'folders' | 'gallery' | 'duplicates';
type AuthMode = 'login' | 'register';

type DuplicatePair = {
  key: string;
  groupKey: string;
  left: DuplicateFile;
  right: DuplicateFile;
  suggestedKeepId: string | null;
  reason: string;
};

type DetailSwipeAxis = 'idle' | 'x' | 'y';

function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authState, setAuthState] = useState<FetchState>({ loading: true, error: null });
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [authForm, setAuthForm] = useState({ username: '', password: '', confirmPassword: '' });
  const [folders, setFolders] = useState<Folder[]>([]);
  const [galleryFiles, setGalleryFiles] = useState<FileItem[]>([]);
  const [galleryTotal, setGalleryTotal] = useState(0);
  const [galleryOffset, setGalleryOffset] = useState(0);
  const [galleryHasMore, setGalleryHasMore] = useState(false);
  const [galleryPageState, setGalleryPageState] = useState<FetchState>({ loading: false, error: null });
  const [gallerySort, setGallerySort] = useState<GallerySort>(() => {
    if (typeof window === 'undefined') return 'mtime_desc';
    const stored = window.localStorage.getItem(gallerySortStorageKey);
    return isGallerySort(stored) ? stored : 'mtime_desc';
  });
  const [galleryFilters, setGalleryFilters] = useState({ photos: false, videos: false, favorites: false });
  const [isGalleryFilterOpen, setIsGalleryFilterOpen] = useState(false);
  const [galleryRandomSeed, setGalleryRandomSeed] = useState<string>(() => makeRandomSeed());
  const [galleryTagQuery, setGalleryTagQuery] = useState('');
  const [galleryTagInput, setGalleryTagInput] = useState('');
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  const [providerInfo, setProviderInfo] = useState<any[]>([]);
  const [providerState, setProviderState] = useState<FetchState>({ loading: false, error: null });
  const [viewMode, setViewMode] = useState<ViewMode>('gallery');
  const [fetchState, setFetchState] = useState<FetchState>({ loading: false, error: null });
  const [deleteState, setDeleteState] = useState<FetchState>({ loading: false, error: null });
  const [favoriteState, setFavoriteState] = useState<FetchState>({ loading: false, error: null });
  const [shareState, setShareState] = useState<FetchState>({ loading: false, error: null });
  const [manualOrderState, setManualOrderState] = useState<FetchState>({ loading: false, error: null });
  const [sauceSources, setSauceSources] = useState<SauceSource[]>([]);
  const [sauceSettings, setSauceSettings] = useState<SauceSettings>({
    display: [],
    targets: [],
    displayInitialized: false
  });
  const [sauceProgress, setSauceProgress] = useState<SauceProgress>(emptySauceProgress);
  const [sauceState, setSauceState] = useState<FetchState>({ loading: false, error: null });
  const [favoritesSyncState, setFavoritesSyncState] = useState<FetchState>({ loading: false, error: null });
  const [favoritesSyncStatus, setFavoritesSyncStatus] = useState<FavoriteSyncStatus | null>(null);
  const favoritesPollRef = useRef<number | null>(null);
  const [favoritesSettingsState, setFavoritesSettingsState] = useState<FetchState>({ loading: false, error: null });
  const [favoritesSettings, setFavoritesSettings] = useState<{
    reverseSyncEnabled: boolean;
    autoSyncMidnight: boolean;
    favoritesRootId: string | null;
  }>({
    reverseSyncEnabled: false,
    autoSyncMidnight: false,
    favoritesRootId: null
  });
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [credentialsState, setCredentialsState] = useState<FetchState>({ loading: false, error: null });
  const [credentialInputs, setCredentialInputs] = useState<
    Record<CredentialProvider, { username: string; apiKey: string }>
  >({
    E621: { username: '', apiKey: '' },
    DANBOORU: { username: '', apiKey: '' },
    SAUCENAO: { username: '', apiKey: '' }
  });
  const [credentialExpanded, setCredentialExpanded] = useState<Record<CredentialProvider, boolean>>({
    E621: false,
    DANBOORU: false,
    SAUCENAO: false
  });
  const [credentialLastProvider, setCredentialLastProvider] = useState<CredentialProvider | null>(null);
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [duplicateStats, setDuplicateStats] = useState<DuplicateScanStats | null>(null);
  const [duplicateState, setDuplicateState] = useState<FetchState>({ loading: false, error: null });
  const [duplicateScanStatus, setDuplicateScanStatus] = useState<DuplicateScanStatus | null>(null);
  const [duplicateAction, setDuplicateAction] = useState<{ loadingId: string | null; error: string | null }>({
    loadingId: null,
    error: null
  });
  const [duplicateResolvedKeys, setDuplicateResolvedKeys] = useState<string[]>([]);
  const [duplicateSettingsState, setDuplicateSettingsState] = useState<FetchState>({ loading: false, error: null });
  const [duplicateSettings, setDuplicateSettings] = useState<DuplicateSettings>({ autoResolve: false });
  const [duplicateOptions, setDuplicateOptions] = useState<DuplicateScanOptions>({
    mediaType: 'ALL',
    pixelThreshold: 0.02,
    sampleSize: 64,
    videoFrames: 3,
    maxComparisons: 2000
  });
  const [fileTags, setFileTags] = useState<FileTag[]>([]);
  const [tagState, setTagState] = useState<FetchState>({ loading: false, error: null });
  const [matchRemoveState, setMatchRemoveState] = useState<FetchState>({ loading: false, error: null });
  const [manualTagInput, setManualTagInput] = useState('');
  const [manualTagCategory, setManualTagCategory] = useState('general');
  const [navPeek, setNavPeek] = useState(false);
  const [mediaFullscreen, setMediaFullscreen] = useState(false);
  const [detailSwipeOffset, setDetailSwipeOffset] = useState(0);
  const [detailSwipeTransition, setDetailSwipeTransition] = useState(false);
  const [detailSwipeLocked, setDetailSwipeLocked] = useState(false);
  const historyActiveRef = useRef(false);
  const dragActiveRef = useRef(false);
  const galleryLoadMoreRef = useRef<HTMLDivElement | null>(null);
  const galleryLoadingRef = useRef(false);
  const galleryRequestRef = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  const pendingNavRef = useRef<number | null>(null);
  const detailSwipeFrameRef = useRef<HTMLDivElement | null>(null);
  const detailSwipeTimerRef = useRef<number | null>(null);
  const detailGestureRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    lastX: number;
    startedAt: number;
    axis: DetailSwipeAxis;
  }>({
    active: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    startedAt: 0,
    axis: 'idle'
  });
  const galleryCacheRef = useRef<
    Map<string, { files: FileItem[]; total: number; offset: number; hasMore: boolean }>
  >(new Map());
  const galleryFilesRef = useRef<FileItem[]>([]);
  const galleryFilterRef = useRef<HTMLDivElement | null>(null);
  const galleryOffsetRef = useRef(0);
  const scanPollingRef = useRef<number | null>(null);
  const lastScanActiveRef = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState({ path: '' });
  const [folderActionState, setFolderActionState] = useState<FetchState>({ loading: false, error: null });
  const galleryPageSize = 200;
  const galleryMediaFilter =
    galleryFilters.photos && !galleryFilters.videos
      ? 'IMAGE'
      : galleryFilters.videos && !galleryFilters.photos
        ? 'VIDEO'
        : 'ALL';
  const galleryFavoritesOnly = galleryFilters.favorites;
  const galleryFilterLabels: string[] = [];
  if (galleryFilters.photos) galleryFilterLabels.push('Photos');
  if (galleryFilters.videos) galleryFilterLabels.push('Videos');
  if (galleryFilters.favorites) galleryFilterLabels.push('Favorites');
  const galleryFilterLabel =
    galleryFilterLabels.length === 0
      ? 'No filters'
      : `Filters (${galleryFilterLabels.length}): ${galleryFilterLabels.join(', ')}`;

  const credentialMap = useMemo(() => {
    const map = new Map<CredentialProvider, CredentialSummary>();
    credentials.forEach((entry) => map.set(entry.provider, entry));
    return map;
  }, [credentials]);

  useEffect(() => {
    galleryFilesRef.current = galleryFiles;
  }, [galleryFiles]);

  useEffect(() => {
    galleryOffsetRef.current = galleryOffset;
  }, [galleryOffset]);

  const loadGalleryPage = useCallback(
    async (options: { reset?: boolean } = {}) => {
      if (galleryLoadingRef.current && !options.reset) return;
      if (options.reset && galleryRequestRef.current.controller) {
        galleryRequestRef.current.controller.abort();
      }
      const requestId = galleryRequestRef.current.id + 1;
      const controller = new AbortController();
      galleryRequestRef.current = { id: requestId, controller };
      galleryLoadingRef.current = true;
      const isRandom = gallerySort === 'random';
      const shouldPaginate = gallerySort !== 'manual';
      const allowCache = !isRandom;
      const filterKey = `${galleryMediaFilter}:${galleryFavoritesOnly ? 'fav' : 'all'}`;
      const cacheKey = isRandom
        ? `${gallerySort}:${galleryTagQuery}:${galleryRandomSeed}:${filterKey}`
        : `${gallerySort}:${galleryTagQuery}:${filterKey}`;
      const cached = allowCache ? galleryCacheRef.current.get(cacheKey) : null;
      if (options.reset && cached) {
        setGalleryFiles(cached.files);
        setGalleryTotal(cached.total);
        setGalleryOffset(cached.offset);
        setGalleryHasMore(cached.hasMore);
      }
      const offset = shouldPaginate ? (options.reset ? 0 : galleryOffsetRef.current) : undefined;
      const limit = shouldPaginate ? galleryPageSize : undefined;
      setGalleryPageState({ loading: true, error: null });
      try {
        const data = await api.getFiles(undefined, gallerySort, galleryTagQuery, {
          limit,
          offset,
          seed: isRandom ? galleryRandomSeed : undefined,
          mediaType: galleryMediaFilter === 'ALL' ? undefined : galleryMediaFilter,
          favoritesOnly: galleryFavoritesOnly ? true : undefined,
          signal: controller.signal
        });
        if (requestId !== galleryRequestRef.current.id) return;
        const nextFiles = data.files;
        const total = data.total ?? nextFiles.length;
        const baseFiles = options.reset || !shouldPaginate ? [] : (cached?.files ?? galleryFilesRef.current);
        const updatedFiles = options.reset || !shouldPaginate ? nextFiles : [...baseFiles, ...nextFiles];
        setGalleryTotal(total);
        setGalleryFiles(updatedFiles);
        const nextOffset = shouldPaginate ? (offset ?? 0) + nextFiles.length : nextFiles.length;
        setGalleryOffset(nextOffset);
        setGalleryHasMore(shouldPaginate ? nextOffset < total : false);
        if (allowCache) {
          galleryCacheRef.current.set(cacheKey, {
            files: updatedFiles,
            total,
            offset: nextOffset,
            hasMore: shouldPaginate ? nextOffset < total : false
          });
        }
        setGalleryPageState({ loading: false, error: null });
      } catch (err) {
        if (requestId !== galleryRequestRef.current.id) return;
        if ((err as Error).name === 'AbortError') {
          setGalleryPageState({ loading: false, error: null });
          return;
        }
        setGalleryPageState({ loading: false, error: (err as Error).message });
      } finally {
        if (requestId === galleryRequestRef.current.id) {
          galleryLoadingRef.current = false;
        }
      }
    },
    [galleryFavoritesOnly, galleryMediaFilter, galleryPageSize, galleryRandomSeed, gallerySort, galleryTagQuery]
  );

  const refreshFolders = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setFetchState({ loading: true, error: null });
    }
    try {
      const f = await api.getFolders();
      setFolders(f);
      if (!options.silent) {
        setFetchState({ loading: false, error: null });
      }
    } catch (err) {
      if (!options.silent) {
        setFetchState({ loading: false, error: (err as Error).message });
      }
    }
  }, []);

  const loadData = useCallback(async () => {
    await refreshFolders();
  }, [refreshFolders]);

  const loadSauces = useCallback(async () => {
    setSauceState({ loading: true, error: null });
    try {
      const data = await api.getSauces();
      setSauceSources(data.sources);
      setSauceSettings({
        display: data.settings.display ?? [],
        targets: data.settings.targets ?? [],
        displayInitialized: data.settings.displayInitialized ?? (data.settings.display?.length ?? 0) > 0
      });
      setSauceProgress(data.progress ?? emptySauceProgress);
      setSauceState({ loading: false, error: null });
    } catch (err) {
      setSauceState({ loading: false, error: (err as Error).message });
    }
  }, []);

  const loadDuplicateSettings = useCallback(async () => {
    setDuplicateSettingsState({ loading: true, error: null });
    try {
      const data = await api.getDuplicateSettings();
      setDuplicateSettings(data);
      setDuplicateSettingsState({ loading: false, error: null });
    } catch (err) {
      setDuplicateSettingsState({ loading: false, error: (err as Error).message });
    }
  }, []);

  const loadFavoritesSettings = useCallback(async () => {
    setFavoritesSettingsState({ loading: true, error: null });
    try {
      const data = await api.getFavoritesSettings();
      setFavoritesSettings(data);
      setFavoritesSettingsState({ loading: false, error: null });
    } catch (err) {
      setFavoritesSettingsState({ loading: false, error: (err as Error).message });
    }
  }, []);

  const loadCredentials = useCallback(async () => {
    setCredentialLastProvider(null);
    setCredentialsState({ loading: true, error: null });
    try {
      const data = await api.getCredentials();
      setCredentials(data);
      const lookup = new Map(data.map((entry) => [entry.provider, entry]));
      setCredentialInputs({
        E621: { username: lookup.get('E621')?.username ?? '', apiKey: '' },
        DANBOORU: { username: lookup.get('DANBOORU')?.username ?? '', apiKey: '' },
        SAUCENAO: { username: '', apiKey: '' }
      });
      setCredentialsState({ loading: false, error: null });
    } catch (err) {
      setCredentialsState({ loading: false, error: (err as Error).message });
    }
  }, []);

  const loadFavoritesSyncStatus = useCallback(async () => {
    try {
      const data = await api.getFavoritesSyncStatus();
      setFavoritesSyncStatus(data);
      if (data.status === 'running') {
        startFavoritesPoll();
      }
    } catch {
      // ignore
    }
  }, []);

  const loadDuplicates = useCallback(
    async (override?: DuplicateScanOptions) => {
      setDuplicateState({ loading: true, error: null });
      try {
        const start = await api.startDuplicateScan(override ?? duplicateOptions);
        let status = start.state;
        setDuplicateScanStatus(status);
        let lastUpdatedAt = status.updatedAt;
        let staleSince = Date.now();
        const STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes with no progress change

        while (true) {
          if (status.progress) {
            setDuplicateScanStatus(status);
          }
          if (status.status === 'done' && status.result) {
            setDuplicateGroups(status.result.groups);
            setDuplicateStats(status.result.stats);
            setDuplicateState({ loading: false, error: null });
            if (duplicateSettings.autoResolve) {
              void autoResolveDuplicates(status.result.groups);
            }
            return;
          }
          if (status.status === 'error') {
            throw new Error(status.error ?? 'Duplicate scan failed');
          }
          if (status.status !== 'running') {
            break;
          }
          // Track staleness based on updatedAt changes
          if (status.updatedAt !== lastUpdatedAt) {
            lastUpdatedAt = status.updatedAt;
            staleSince = Date.now();
          } else if (Date.now() - staleSince > STALE_TIMEOUT_MS) {
            throw new Error('Duplicate scan timed out (no progress for 5 minutes)');
          }
          await wait(800);
          status = await api.getDuplicateScanStatus();
          setDuplicateScanStatus(status);
        }
      } catch (err) {
        setDuplicateState({ loading: false, error: (err as Error).message });
      }
    },
    [duplicateOptions, duplicateSettings.autoResolve]
  );

  useEffect(() => {
    let cancelled = false;
    const bootstrapAuth = async () => {
      setAuthState({ loading: true, error: null });
      try {
        const user = await api.getCurrentUser();
        if (cancelled) return;
        setAuthUser(user);
        setAuthState({ loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        const status = (err as Error & { status?: number }).status;
        if (status === 401) {
          setAuthUser(null);
          setAuthState({ loading: false, error: null });
          return;
        }
        setAuthState({ loading: false, error: (err as Error).message });
      }
    };
    void bootstrapAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleAuthRequired = () => {
      if (favoritesPollRef.current !== null) {
        window.clearInterval(favoritesPollRef.current);
        favoritesPollRef.current = null;
      }
      galleryCacheRef.current.clear();
      setSelectedFile(null);
      setAuthUser(null);
      setFolders([]);
      setGalleryFiles([]);
      setGalleryTotal(0);
      setGalleryOffset(0);
      setGalleryHasMore(false);
      setCredentials([]);
      setFavoritesSyncStatus(null);
      setDuplicateGroups([]);
      setDuplicateStats(null);
      setDuplicateScanStatus(null);
      setAuthState({ loading: false, error: null });
    };
    window.addEventListener(authRequiredEvent, handleAuthRequired);
    return () => {
      window.removeEventListener(authRequiredEvent, handleAuthRequired);
    };
  }, []);

  useEffect(() => {
    if (!authUser) return;
    void loadData();
  }, [authUser, loadData]);

  useEffect(() => {
    const anyScanning = folders.some((folder) => folder.status === 'SCANNING');
    if (anyScanning && scanPollingRef.current === null) {
      scanPollingRef.current = window.setInterval(() => {
        void refreshFolders({ silent: true });
      }, 5000);
    }
    if (!anyScanning && scanPollingRef.current !== null) {
      window.clearInterval(scanPollingRef.current);
      scanPollingRef.current = null;
    }
  }, [folders, refreshFolders]);

  useEffect(() => {
    return () => {
      if (scanPollingRef.current !== null) {
        window.clearInterval(scanPollingRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const anyScanning = folders.some((folder) => folder.status === 'SCANNING');
    if (lastScanActiveRef.current && !anyScanning) {
      lastScanActiveRef.current = false;
      if (viewMode === 'gallery') {
        void loadGalleryPage({ reset: true });
      }
    } else if (anyScanning) {
      lastScanActiveRef.current = true;
    }
  }, [folders, loadGalleryPage, viewMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handle = window.setTimeout(() => {
      setGalleryTagQuery(galleryTagInput.trim());
    }, 300);
    return () => window.clearTimeout(handle);
  }, [galleryTagInput]);

  useEffect(() => {
    if (!isGalleryFilterOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && galleryFilterRef.current?.contains(target)) return;
      setIsGalleryFilterOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsGalleryFilterOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKey);
    };
  }, [isGalleryFilterOpen]);

  useEffect(() => {
    if (!authUser) return;
    if (viewMode !== 'gallery') return;
    const isRandom = gallerySort === 'random';
    const filterKey = `${galleryMediaFilter}:${galleryFavoritesOnly ? 'fav' : 'all'}`;
    const cacheKey = isRandom
      ? `${gallerySort}:${galleryTagQuery}:${galleryRandomSeed}:${filterKey}`
      : `${gallerySort}:${galleryTagQuery}:${filterKey}`;
    const cached = isRandom ? null : galleryCacheRef.current.get(cacheKey);
    if (cached) {
      setGalleryFiles(cached.files);
      setGalleryOffset(cached.offset);
      setGalleryHasMore(cached.hasMore);
      setGalleryTotal(cached.total);
    } else {
      setGalleryFiles([]);
      setGalleryOffset(0);
      setGalleryHasMore(false);
      setGalleryTotal(0);
    }
    void loadGalleryPage({ reset: true });
  }, [authUser, viewMode, galleryFavoritesOnly, galleryMediaFilter, galleryRandomSeed, gallerySort, galleryTagQuery, loadGalleryPage]);

  useEffect(() => {
    if (!authUser) return;
    void loadSauces();
  }, [authUser, loadSauces]);

  useEffect(() => {
    const delta = pendingNavRef.current;
    if (!selectedFile || !delta) return;
    if (galleryPageState.error) {
      pendingNavRef.current = null;
      return;
    }
    const idx = galleryFiles.findIndex((file) => file.id === selectedFile.id);
    if (idx === -1) {
      pendingNavRef.current = null;
      return;
    }
    const next = galleryFiles[idx + delta];
    if (next) {
      pendingNavRef.current = null;
      setSelectedFile(next);
    }
  }, [galleryFiles, galleryPageState.error, selectedFile]);

  useEffect(() => {
    if (viewMode !== 'gallery') return;
    if (!galleryHasMore) return;
    const target = galleryLoadMoreRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadGalleryPage();
        }
      },
      { rootMargin: '400px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [galleryHasMore, loadGalleryPage, viewMode]);

  const submitAuth = async () => {
    const username = authForm.username.trim();
    const password = authForm.password;
    if (!username || !password) {
      setAuthState({ loading: false, error: 'Username and password are required' });
      return;
    }
    if (authMode === 'register' && password !== authForm.confirmPassword) {
      setAuthState({ loading: false, error: 'Passwords do not match' });
      return;
    }
    setAuthState({ loading: true, error: null });
    try {
      const user =
        authMode === 'register'
          ? await api.register({ username, password })
          : await api.login({ username, password });
      galleryCacheRef.current.clear();
      setAuthUser(user);
      setAuthForm({ username: '', password: '', confirmPassword: '' });
      setAuthState({ loading: false, error: null });
    } catch (err) {
      setAuthState({ loading: false, error: (err as Error).message });
    }
  };

  const logout = async () => {
    setAuthState({ loading: true, error: null });
    try {
      await api.logout();
    } catch {
      // Clear local state even if the session is already gone server-side.
    } finally {
      if (favoritesPollRef.current !== null) {
        window.clearInterval(favoritesPollRef.current);
        favoritesPollRef.current = null;
      }
      galleryCacheRef.current.clear();
      setSelectedFile(null);
      setAuthUser(null);
      setFolders([]);
      setGalleryFiles([]);
      setGalleryTotal(0);
      setGalleryOffset(0);
      setGalleryHasMore(false);
      setCredentials([]);
      setFavoritesSyncStatus(null);
      setDuplicateGroups([]);
      setDuplicateStats(null);
      setDuplicateScanStatus(null);
      setAuthState({ loading: false, error: null });
    }
  };


  const onAddFolder = async () => {
    const path = folderDraft.path.trim();
    if (!path) return;
    setFolderActionState({ loading: true, error: null });
    try {
      await api.addFolder(path);
      setFolderDraft({ path: '' });
      await loadData();
      setFolderActionState({ loading: false, error: null });
    } catch (err) {
      setFolderActionState({ loading: false, error: (err as Error).message });
    }
  };

  const onDeleteFolder = async (folder: Folder) => {
    if (!window.confirm(`Remove "${folder.path}" from the watch list?`)) return;
    setFolderActionState({ loading: true, error: null });
    try {
      await api.deleteFolder(folder.id);
      setFolders((prev) => prev.filter((item) => item.id !== folder.id));
      setFolderActionState({ loading: false, error: null });
    } catch (err) {
      setFolderActionState({ loading: false, error: (err as Error).message });
    }
  };

  const onDeleteFile = async (fileId: string) => {
    if (!window.confirm('Delete this file from disk? This cannot be undone.')) return;
    const nextFile = selectedFile?.id === fileId ? pickNextFileAfterDelete(galleryFiles, fileId) : null;
    setDeleteState({ loading: true, error: null });
    try {
      await api.deleteFile(fileId);
      setGalleryFiles((prev) => prev.filter((file) => file.id !== fileId));
      setGalleryTotal((prev) => (prev > 0 ? prev - 1 : 0));
      setGalleryOffset((prev) => Math.max(0, prev - 1));
      const filterKey = `${galleryMediaFilter}:${galleryFavoritesOnly ? 'fav' : 'all'}`;
      const cacheKey =
        gallerySort === 'random'
          ? `${gallerySort}:${galleryTagQuery}:${galleryRandomSeed}:${filterKey}`
          : `${gallerySort}:${galleryTagQuery}:${filterKey}`;
      const cached = gallerySort !== 'random' ? galleryCacheRef.current.get(cacheKey) : null;
      if (cached) {
        const nextFiles = cached.files.filter((file) => file.id !== fileId);
        const nextTotal = cached.total > 0 ? cached.total - 1 : 0;
        const nextOffset = Math.max(0, cached.offset - 1);
        const nextHasMore = cached.hasMore ? nextOffset < nextTotal : false;
        galleryCacheRef.current.set(cacheKey, {
          files: nextFiles,
          total: nextTotal,
          offset: nextOffset,
          hasMore: nextHasMore
        });
      }
      if (selectedFile?.id === fileId) {
        if (nextFile) {
          setSelectedFile(nextFile);
        } else {
          closeFile();
        }
      }
      setDeleteState({ loading: false, error: null });
    } catch (err) {
      setDeleteState({ loading: false, error: (err as Error).message });
    }
  };

  const updateFavoriteFlag = useCallback(
    (fileId: string, isFavorite: boolean) => {
      const removeFromFavoritesView =
        galleryFavoritesOnly && !isFavorite && galleryFilesRef.current.some((file) => file.id === fileId);
      setGalleryFiles((prev) => {
        const updated = prev.map((file) => (file.id === fileId ? { ...file, isFavorite } : file));
        if (galleryFavoritesOnly && !isFavorite) {
          return updated.filter((file) => file.id !== fileId);
        }
        return updated;
      });
      if (removeFromFavoritesView) {
        setGalleryTotal((prev) => (prev > 0 ? prev - 1 : 0));
        setGalleryOffset((prev) => Math.max(0, prev - 1));
      }
      setSelectedFile((prev) => (prev && prev.id === fileId ? { ...prev, isFavorite } : prev));
      const filterKey = `${galleryMediaFilter}:${galleryFavoritesOnly ? 'fav' : 'all'}`;
      const cacheKey =
        gallerySort === 'random'
          ? `${gallerySort}:${galleryTagQuery}:${galleryRandomSeed}:${filterKey}`
          : `${gallerySort}:${galleryTagQuery}:${filterKey}`;
      const cached = gallerySort !== 'random' ? galleryCacheRef.current.get(cacheKey) : null;
      if (cached) {
        const existedInCache = cached.files.some((file) => file.id === fileId);
        let nextFiles = cached.files.map((file) => (file.id === fileId ? { ...file, isFavorite } : file));
        let nextTotal = cached.total;
        let nextOffset = cached.offset;
        let nextHasMore = cached.hasMore;
        if (galleryFavoritesOnly && !isFavorite) {
          nextFiles = nextFiles.filter((file) => file.id !== fileId);
          if (existedInCache) {
            nextTotal = nextTotal > 0 ? nextTotal - 1 : 0;
            nextOffset = Math.max(0, nextOffset - 1);
            nextHasMore = cached.hasMore ? nextOffset < nextTotal : false;
          }
        }
        galleryCacheRef.current.set(cacheKey, {
          ...cached,
          files: nextFiles,
          total: nextTotal,
          offset: nextOffset,
          hasMore: nextHasMore
        });
      }
    },
    [galleryFavoritesOnly, galleryMediaFilter, galleryRandomSeed, gallerySort, galleryTagQuery]
  );

  const onToggleFavorite = async () => {
    if (!selectedFile) return;
    const nextFavorite = !selectedFile.isFavorite;
    setFavoriteState({ loading: true, error: null });
    try {
      const resp = await api.updateFileFavorite(selectedFile.id, nextFavorite);
      updateFavoriteFlag(selectedFile.id, resp.isFavorite);
      setFavoriteState({ loading: false, error: null });
    } catch (err) {
      setFavoriteState({ loading: false, error: (err as Error).message });
    }
  };

  const onDownloadFile = async () => {
    if (!selectedFile) return;
    const fileName = selectedFileName || `file-${selectedFile.id}`;
    const url = api.getFileContentUrl(selectedFile.id, { download: true });
    setShareState({ loading: true, error: null });
    try {
      const blob = await api.getFileContentBlob(selectedFile.id, { download: true });
      const file = new File([blob], fileName, {
        type: blob.type || guessMimeType(fileName, selectedFile.mediaType)
      });
      if (navigator.share) {
        try {
          await navigator.share({ files: [file], title: fileName });
          setShareState({ loading: false, error: null });
          return;
        } catch (shareErr) {
          if (shareErr instanceof DOMException && shareErr.name === 'AbortError') {
            setShareState({ loading: false, error: null });
            return;
          }
          // share failed — fall through to download
        }
      }
      const blobUrl = URL.createObjectURL(file);
      triggerDownload(blobUrl, fileName);
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
      setShareState({ loading: false, error: null });
    } catch (err) {
      triggerDownload(url, fileName);
      setShareState({ loading: false, error: (err as Error).message });
    }
  };

  const onSwitchView = async (mode: ViewMode) => {
    setViewMode(mode);
    if (mode === 'folders') {
      void loadSauces();
      void loadFavoritesSettings();
      void loadFavoritesSyncStatus();
      void loadCredentials();
    }
    if (mode === 'duplicates') {
      void loadDuplicateSettings();
    }
  };

  const applyGallerySort = (sort: GallerySort) => {
    if (sort === 'random') {
      setGalleryRandomSeed(makeRandomSeed());
    }
    setGallerySort(sort);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(gallerySortStorageKey, sort);
    }
  };

  const saveManualOrder = useCallback(
    async (next: FileItem[]) => {
      setManualOrderState({ loading: true, error: null });
      try {
        await api.updateManualOrder(next.map((file) => file.id));
        setManualOrderState({ loading: false, error: null });
      } catch (err) {
        setManualOrderState({ loading: false, error: (err as Error).message });
        void loadData();
      }
    },
    [loadData]
  );

  const moveManualItem = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      setGalleryFiles((prev) => {
        const fromIndex = prev.findIndex((item) => item.id === fromId);
        const toIndex = prev.findIndex((item) => item.id === toId);
        if (fromIndex === -1 || toIndex === -1) return prev;
        const next = [...prev];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        void saveManualOrder(next);
        return next;
      });
    },
    [saveManualOrder]
  );

  const loadProviders = async (fileId: string) => {
    try {
      const resp = await api.getProviders(fileId);
      setProviderInfo(resp.providers);
    } catch (err) {
      setProviderInfo([]);
    }
  };

  const stopFavoritesPoll = () => {
    if (favoritesPollRef.current !== null) {
      window.clearInterval(favoritesPollRef.current);
      favoritesPollRef.current = null;
    }
  };

  const pollFavoritesSync = useCallback(async () => {
    try {
      const data = await api.getFavoritesSyncStatus();
      setFavoritesSyncStatus(data);
      if (data.status !== 'running') {
        stopFavoritesPoll();
      }
    } catch (err) {
      stopFavoritesPoll();
      setFavoritesSyncState({ loading: false, error: (err as Error).message });
    }
  }, []);

  const startFavoritesPoll = () => {
    if (favoritesPollRef.current !== null) return;
    favoritesPollRef.current = window.setInterval(() => {
      void pollFavoritesSync();
    }, 2000);
  };

  const runFavoritesSync = async (deleteMissing: boolean) => {
    setFavoritesSyncState({ loading: true, error: null });
    try {
      const data = await api.syncFavorites({ deleteMissing });
      setFavoritesSyncStatus(data.state);
      setFavoritesSyncState({ loading: false, error: null });
      if (data.state.status === 'running') {
        startFavoritesPoll();
      }
    } catch (err) {
      setFavoritesSyncState({ loading: false, error: (err as Error).message });
    }
  };

  const updateFavoritesSettings = async (updates: {
    reverseSyncEnabled?: boolean;
    autoSyncMidnight?: boolean;
    favoritesRootId?: string | null;
  }) => {
    setFavoritesSettingsState({ loading: true, error: null });
    try {
      const data = await api.updateFavoritesSettings(updates);
      setFavoritesSettings(data);
      setFavoritesSettingsState({ loading: false, error: null });
    } catch (err) {
      setFavoritesSettingsState({ loading: false, error: (err as Error).message });
    }
  };

  const updateDuplicateSettings = async (updates: Partial<DuplicateSettings>) => {
    setDuplicateSettingsState({ loading: true, error: null });
    try {
      const data = await api.updateDuplicateSettings(updates);
      setDuplicateSettings(data);
      setDuplicateSettingsState({ loading: false, error: null });
    } catch (err) {
      setDuplicateSettingsState({ loading: false, error: (err as Error).message });
    }
  };

  const updateCredentialInput = (
    provider: CredentialProvider,
    field: 'username' | 'apiKey',
    value: string
  ) => {
    setCredentialInputs((prev) => ({
      ...prev,
      [provider]: {
        ...prev[provider],
        [field]: value
      }
    }));
  };

  const saveCredential = async (provider: CredentialProvider) => {
    setCredentialLastProvider(provider);
    setCredentialsState({ loading: true, error: null });
    try {
      const input = credentialInputs[provider];
      const username = input.username.trim();
      const apiKey = input.apiKey.trim();
      const payload: { provider: CredentialProvider; username?: string; apiKey?: string } = { provider };
      if (provider !== 'SAUCENAO' && username) {
        payload.username = username;
      }
      if (apiKey) {
        payload.apiKey = apiKey;
      }
      if (!payload.username && !payload.apiKey) {
        setCredentialsState({ loading: false, error: null });
        return;
      }
      const updated = await api.updateCredential(payload);
      setCredentials((prev) => {
        const map = new Map(prev.map((entry) => [entry.provider, entry]));
        map.set(updated.provider, updated);
        return Array.from(map.values());
      });
      setCredentialInputs((prev) => ({
        ...prev,
        [provider]: {
          username: provider === 'SAUCENAO' ? '' : updated.username ?? prev[provider].username,
          apiKey: ''
        }
      }));
      setCredentialExpanded((prev) => ({ ...prev, [provider]: false }));
      setCredentialsState({ loading: false, error: null });
    } catch (err) {
      setCredentialsState({ loading: false, error: (err as Error).message });
    }
  };

  const logoutCredential = async (provider: CredentialProvider) => {
    setCredentialLastProvider(provider);
    setCredentialsState({ loading: true, error: null });
    try {
      const updated = await api.updateCredential({ provider, username: '', apiKey: '' });
      setCredentials((prev) => {
        const map = new Map(prev.map((entry) => [entry.provider, entry]));
        map.set(updated.provider, updated);
        return Array.from(map.values());
      });
      setCredentialInputs((prev) => ({
        ...prev,
        [provider]: { username: '', apiKey: '' }
      }));
      setCredentialExpanded((prev) => ({ ...prev, [provider]: false }));
      setCredentialsState({ loading: false, error: null });
    } catch (err) {
      setCredentialsState({ loading: false, error: (err as Error).message });
    }
  };

  const tagRefreshRef = useRef(new Set<string>());

  const loadTags = useCallback(async (fileId: string) => {
    setTagState({ loading: true, error: null });
    try {
      const resp = await api.getFileTags(fileId);
      if (resp.tags.length === 0 && !tagRefreshRef.current.has(fileId)) {
        tagRefreshRef.current.add(fileId);
        const refreshed = await api.refreshFileTags(fileId);
        setFileTags(refreshed.tags);
      } else {
        setFileTags(resp.tags);
      }
      setTagState({ loading: false, error: null });
    } catch (err) {
      setFileTags([]);
      setTagState({ loading: false, error: (err as Error).message });
    }
  }, []);

  const refreshTags = async () => {
    if (!selectedFile) return;
    setTagState({ loading: true, error: null });
    try {
      const refreshed = await api.refreshFileTags(selectedFile.id);
      setFileTags(refreshed.tags);
      tagRefreshRef.current.add(selectedFile.id);
      setTagState({ loading: false, error: null });
    } catch (err) {
      setTagState({ loading: false, error: (err as Error).message });
    }
  };

  const clearTags = async () => {
    if (!selectedFile) return;
    if (!window.confirm('Delete all tags for this file?')) return;
    setTagState({ loading: true, error: null });
    try {
      await api.clearFileTags(selectedFile.id);
      setFileTags([]);
      tagRefreshRef.current.add(selectedFile.id);
      setTagState({ loading: false, error: null });
    } catch (err) {
      setTagState({ loading: false, error: (err as Error).message });
    }
  };

  useEffect(() => {
    if (selectedFile) {
      void loadProviders(selectedFile.id);
      void loadTags(selectedFile.id);
      setMatchRemoveState({ loading: false, error: null });
    } else {
      setProviderInfo([]);
      setFileTags([]);
    }
  }, [selectedFile, loadTags]);

  const sauceKeys = useMemo(() => sauceSources.map((source) => canonicalizeSauceKey(source.key)), [sauceSources]);
  const displayFilterActive = (sauceSettings.displayInitialized ?? false) || sauceSettings.display.length > 0;
  const displaySet = useMemo(() => {
    if (!displayFilterActive) return new Set(sauceKeys.map(canonicalizeSauceKey));
    return new Set(sauceSettings.display.map(canonicalizeSauceKey));
  }, [displayFilterActive, sauceSettings.display, sauceKeys]);
  const targetSet = useMemo(
    () => new Set(sauceSettings.targets.map(canonicalizeSauceKey)),
    [sauceSettings.targets]
  );
  const sauceProgressSegments = useMemo(() => {
    const total = sauceProgress.total;
    if (!total) {
      return { matched: 0, failed: 0, pending: 0 };
    }
    const matched = (sauceProgress.matched / total) * 100;
    const failed = (sauceProgress.failed / total) * 100;
    return {
      matched,
      failed,
      pending: Math.max(0, 100 - matched - failed)
    };
  }, [sauceProgress]);

  const providerHighlights = useMemo(() => {
    const latestByProvider = new Map<string, any>();
    providerInfo.forEach((run) => {
      if (!latestByProvider.has(run.provider)) {
        latestByProvider.set(run.provider, run);
      }
    });

    const highlights: {
      id: string;
      provider: string;
      sourceUrl: string;
      sourceName: string;
      score: number | null;
      distance: number | null;
    }[] = [];

    for (const [provider, run] of latestByProvider.entries()) {
      const threshold = providerScoreThresholds[provider as ProviderKind] ?? 0;
      const results = Array.isArray(run.results) && run.results.length
        ? run.results
        : [
            {
              sourceUrl: run.sourceUrl ?? null,
              score: run.score ?? null,
              sourceName: null,
              distance: null
            }
          ];
      for (const result of results) {
        if (!result?.sourceUrl) continue;
        if (displayFilterActive) {
          const key = sauceKeyFromResult(result.sourceUrl, result.sourceName ?? null);
          if (!key || !displaySet.has(key)) continue;
        }
        const score = resolveProviderScore(provider as ProviderKind, result);
        if (score === null || score < threshold) continue;
        const distance =
          typeof result.distance === 'number'
            ? result.distance
            : score !== null
              ? Math.max(0, Math.round(100 - score))
              : null;
        highlights.push({
          id: `${run.id}-${result.sourceUrl}`,
          provider,
          sourceUrl: result.sourceUrl,
          sourceName: result.sourceName ?? provider,
          score,
          distance
        });
      }
    }

    return highlights;
  }, [providerInfo, displayFilterActive, displaySet]);

  const tagGroups = useMemo(() => {
    const map = new Map<
      string,
      { tag: string; category: string; sources: Set<string>; score: number | null; hasManual: boolean }
    >();
    for (const tag of fileTags) {
      const key = `${tag.category}:${tag.tag}`;
      const existing = map.get(key);
      const score = typeof tag.score === 'number' ? tag.score : null;
      if (existing) {
        existing.sources.add(tag.source);
        if (score !== null && (existing.score === null || score > existing.score)) {
          existing.score = score;
        }
        if (tag.source === 'MANUAL') existing.hasManual = true;
      } else {
        map.set(key, {
          tag: tag.tag,
          category: tag.category,
          sources: new Set([tag.source]),
          score,
          hasManual: tag.source === 'MANUAL'
        });
      }
    }
    const grouped = Array.from(map.values()).sort((a, b) => a.tag.localeCompare(b.tag));
    const order = ['artist', 'character', 'copyright', 'species', 'general', 'meta', 'lore', 'invalid', 'other'];
    const categories = new Map<string, typeof grouped>();
    for (const entry of grouped) {
      const key = entry.category || 'other';
      const bucket = categories.get(key) ?? [];
      bucket.push(entry);
      categories.set(key, bucket);
    }
    const ordered = Array.from(categories.entries()).sort((a, b) => {
      const idxA = order.indexOf(a[0]);
      const idxB = order.indexOf(b[0]);
      if (idxA === -1 && idxB === -1) return a[0].localeCompare(b[0]);
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });
    return ordered.map(([category, tags]) => ({ category, tags }));
  }, [fileTags]);

  const favoritesSummary = useMemo(() => {
    if (!favoritesSyncStatus?.results?.length) return [];
    return favoritesSyncStatus.results.map((entry) => {
      const errors = entry.errors.length ? ` • ${entry.errors.length} errors` : '';
      return `${entry.provider}: ${entry.added} added, ${entry.removed} removed, ${entry.skipped} skipped, ${entry.fetched} fetched${errors}`;
    });
  }, [favoritesSyncStatus]);

  const favoritesErrors = useMemo(() => {
    if (!favoritesSyncStatus?.results?.length) return [];
    return favoritesSyncStatus.results.flatMap((entry) =>
      entry.errors.map((error) => `${entry.provider}: ${error}`)
    );
  }, [favoritesSyncStatus]);

  const favoritesProgress = useMemo(() => {
    const providers = favoritesSyncStatus?.progress?.providers ?? [];
    const total = providers.reduce((sum, entry) => sum + (entry.total || 0), 0);
    const processed = providers.reduce((sum, entry) => sum + Math.min(entry.processed || 0, entry.total || 0), 0);
    if (!total) return null;
    return Math.min(100, Math.round((processed / total) * 100));
  }, [favoritesSyncStatus]);

  const e621Credential = credentialMap.get('E621');
  const danbooruCredential = credentialMap.get('DANBOORU');
  const saucenaoCredential = credentialMap.get('SAUCENAO');
  const e621Ready = isCredentialReady('E621', e621Credential);
  const danbooruReady = isCredentialReady('DANBOORU', danbooruCredential);
  const saucenaoReady = isCredentialReady('SAUCENAO', saucenaoCredential);

  const tagSourceSummary = useMemo(() => {
    if (fileTags.length === 0) return 'none';
    const sources = Array.from(new Set(fileTags.map((tag) => tag.source)));
    return sources.map((source) => source.toLowerCase()).join(', ');
  }, [fileTags]);

  const duplicatePairs = useMemo<DuplicatePair[]>(() => {
    const pairs: DuplicatePair[] = [];
    const resolved = new Set(duplicateResolvedKeys);
    duplicateGroups.forEach((group) => {
      if (group.files.length < 2) return;
      const sorted = [...group.files].sort(compareDuplicatePreference);
      const primary = sorted[0];
      sorted.slice(1).forEach((other) => {
        const suggestion = pickDuplicateSuggestion(primary, other);
        const key = `${group.key}:${primary.id}:${other.id}`;
        if (resolved.has(key)) return;
        pairs.push({
          key,
          groupKey: group.key,
          left: primary,
          right: other,
          suggestedKeepId: suggestion.keepId,
          reason: suggestion.reason
        });
      });
    });
    return pairs;
  }, [duplicateGroups, duplicateResolvedKeys]);

  const resolveDuplicateChoice = async (
    _keep: DuplicateFile,
    discard: DuplicateFile,
    options: { confirm?: boolean } = {}
  ) => {
    if (options.confirm !== false) {
      if (!window.confirm(`Delete "${basenameFromPath(discard.path)}"? This cannot be undone.`)) return;
    }
    setDuplicateAction({ loadingId: discard.id, error: null });
    try {
      await api.deleteFile(discard.id);
      setDuplicateGroups((prev) =>
        prev
          .map((group) => ({
            ...group,
            files: group.files.filter((file) => file.id !== discard.id)
          }))
          .filter((group) => group.files.length > 1)
      );
      setGalleryFiles((prev) => prev.filter((file) => file.id !== discard.id));
      if (selectedFile?.id === discard.id) {
        closeFile();
      }
      setDuplicateAction({ loadingId: null, error: null });
    } catch (err) {
      setDuplicateAction({ loadingId: null, error: (err as Error).message });
    }
  };

  const resolveDuplicateKeepBoth = (pairKey: string) => {
    setDuplicateResolvedKeys((prev) => (prev.includes(pairKey) ? prev : [...prev, pairKey]));
  };

  const autoResolveDuplicates = async (groups: DuplicateGroup[]) => {
    const candidates = groups.filter((group) => group.files.length > 1);
    if (!candidates.length) return;
    const discardPairs: { keep: DuplicateFile; discard: DuplicateFile; key: string }[] = [];
    const keepBothKeys: string[] = [];
    for (const group of candidates) {
      const sorted = [...group.files].sort(compareDuplicatePreference);
      const winner = sorted[0];
      sorted.slice(1).forEach((file) => {
        if (file.id === winner.id) return;
        const suggestion = pickDuplicateSuggestion(winner, file);
        const key = `${group.key}:${winner.id}:${file.id}`;
        if (!suggestion.keepId) {
          keepBothKeys.push(key);
          return;
        }
        const keep = suggestion.keepId === winner.id ? winner : file;
        const discard = suggestion.keepId === winner.id ? file : winner;
        discardPairs.push({ keep, discard, key });
      });
    }
    if (!discardPairs.length && keepBothKeys.length === 0) return;
    if (keepBothKeys.length > 0) {
      setDuplicateResolvedKeys((prev) => Array.from(new Set([...prev, ...keepBothKeys])));
    }
    if (!discardPairs.length) return;
    const confirm = window.confirm(
      `Auto-resolve is enabled. Delete ${discardPairs.length} duplicates now? This cannot be undone.`
    );
    if (!confirm) return;
    for (const pair of discardPairs) {
      try {
        await resolveDuplicateChoice(pair.keep, pair.discard, { confirm: false });
        setDuplicateResolvedKeys((prev) => (prev.includes(pair.key) ? prev : [...prev, pair.key]));
      } catch (err) {
        setDuplicateAction({ loadingId: null, error: (err as Error).message });
        break;
      }
    }
  };

  const renderDuplicateCard = (file: DuplicateFile, suggested: boolean, reason: string) => (
    <div className={`duplicate-card${suggested ? ' is-suggested' : ''}`}>
      <div className="duplicate-thumb">
        {file.thumbUrl ? (
          <img src={`${API_BASE}${file.thumbUrl}`} alt={file.path} />
        ) : (
          <div className="text-secondary small">{file.mediaType.toLowerCase()}</div>
        )}
      </div>
      <div className="d-flex justify-content-between align-items-center">
        <div className="fw-semibold text-truncate">{basenameFromPath(file.path)}</div>
        {suggested ? <span className="badge bg-success duplicate-suggested-badge">Suggested</span> : null}
      </div>
      <div className="text-secondary small">
        {fileTypeFromPath(file.path, file.mediaType)} · {formatSizeMb(file.sizeBytes)}
        {file.width && file.height ? ` · ${file.width}×${file.height}` : ''}
      </div>
      {file.favoriteProviders?.length ? (
        <div className="text-secondary small">
          favorites: {file.favoriteProviders.map((provider) => provider.toLowerCase()).join(', ')}
        </div>
      ) : null}
      {suggested ? <div className="text-success small duplicate-suggested-reason">{reason}</div> : null}
      <div className="text-secondary small duplicate-path">{file.path}</div>
    </div>
  );

  const addManualTag = async () => {
    if (!selectedFile) return;
    const value = manualTagInput.trim();
    if (!value) return;
    try {
      setTagState({ loading: true, error: null });
      await api.addManualTag(selectedFile.id, value, manualTagCategory);
      setManualTagInput('');
      await loadTags(selectedFile.id);
      setTagState({ loading: false, error: null });
    } catch (err) {
      setTagState({ loading: false, error: (err as Error).message });
    }
  };

  const removeManualTag = async (tag: string, category: string) => {
    if (!selectedFile) return;
    try {
      setTagState({ loading: true, error: null });
      await api.removeManualTag(selectedFile.id, tag, category);
      await loadTags(selectedFile.id);
      setTagState({ loading: false, error: null });
    } catch (err) {
      setTagState({ loading: false, error: (err as Error).message });
    }
  };

  const removeTopMatch = async (sourceUrl: string) => {
    if (!selectedFile) return;
    try {
      setMatchRemoveState({ loading: true, error: null });
      const resp = await api.removeTopMatch(selectedFile.id, sourceUrl);
      setProviderInfo(resp.providers);
      setFileTags(resp.tags);
      tagRefreshRef.current.add(selectedFile.id);
      await loadSauces();
      setMatchRemoveState({ loading: false, error: null });
    } catch (err) {
      setMatchRemoveState({ loading: false, error: (err as Error).message });
    }
  };

  const providerMeta = useMemo(() => {
    if (!selectedFile) return null;
    const latestByProvider = new Map<ProviderKind, any>();
    let latestRunMs = 0;
    let firstRunMs = Number.POSITIVE_INFINITY;
    let activeRun = false;
    let targetHit = false;

    providerInfo.forEach((run) => {
      if (run.status === 'RUNNING' || run.status === 'PENDING') {
        activeRun = true;
      }
      const runMs = new Date(run.completedAt ?? run.createdAt).getTime();
      if (!Number.isNaN(runMs) && runMs > latestRunMs) {
        latestRunMs = runMs;
      }
      if (!Number.isNaN(runMs) && runMs < firstRunMs) {
        firstRunMs = runMs;
      }
      const existing = latestByProvider.get(run.provider);
      const existingMs = existing ? new Date(existing.completedAt ?? existing.createdAt).getTime() : 0;
      if (!existing || runMs > existingMs) {
        latestByProvider.set(run.provider, run);
      }
    });

    if (targetSet.size > 0) {
      for (const run of providerInfo) {
        if (run.status === 'PENDING' || run.status === 'RUNNING') continue;
        const threshold = providerScoreThresholds[run.provider as ProviderKind] ?? 0;
        const results = Array.isArray(run.results) && run.results.length
          ? run.results
          : [
              {
                sourceUrl: run.sourceUrl ?? null,
                sourceName: null,
                score: run.score ?? null
              }
            ];
        for (const result of results) {
          const score = resolveProviderScore(run.provider as ProviderKind, result);
          if (score === null || score < threshold) continue;
          const key = sauceKeyFromResult(result.sourceUrl, result.sourceName ?? null);
          if (key && targetSet.has(key)) {
            targetHit = true;
            break;
          }
        }
        if (targetHit) break;
      }
    }

    const missingProviders = targetHit ? [] : providerKinds.filter((provider) => !latestByProvider.has(provider));
    let nextAutoScanAt: number | null = null;
    const dayMs = 24 * 60 * 60 * 1000;

    for (const [provider, run] of latestByProvider.entries()) {
      const runMs = new Date(run.completedAt ?? run.createdAt).getTime();
      if (Number.isNaN(runMs)) continue;
      const nextAt = runMs + dayMs;
      if (nextAutoScanAt === null || nextAt < nextAutoScanAt) {
        nextAutoScanAt = nextAt;
      }
    }

    return {
      hasRuns: providerInfo.length > 0,
      missingProviders,
      latestRunAt: latestRunMs ? new Date(latestRunMs).toISOString() : null,
      nextAutoScanAt,
      activeRun,
      targetHit,
      expired: Number.isFinite(firstRunMs) ? Date.now() - firstRunMs > 7 * dayMs : false
    };
  }, [providerInfo, selectedFile, targetSet]);

  const nextAutoScanText = useMemo(() => {
    if (!providerMeta) return '—';
    if (providerMeta.activeRun) return 'running now';
    if (providerMeta.targetHit) return 'stopped (target found)';
    if (providerMeta.missingProviders.length > 0) return 'pending (missing providers rotate every 10 min)';
    if (!providerMeta.hasRuns) return 'pending (missing providers rotate every 10 min)';
    if (providerMeta.expired) return 'stopped (7-day window elapsed)';
    if (providerMeta.nextAutoScanAt === null) return 'due now';
    return formatRemaining(providerMeta.nextAutoScanAt - Date.now());
  }, [providerMeta]);

  const selectedFileName = selectedFile ? basenameFromPath(selectedFile.path) || selectedFile.path : '';
  const selectedFileType = selectedFile ? fileTypeFromPath(selectedFile.path, selectedFile.mediaType) : '';
  const selectedFileFavorite = selectedFile?.isFavorite ?? false;
  const galleryCountText = galleryTotal ? `${galleryTotal}` : `${galleryFiles.length}`;

  const runProviders = async (providers: Array<'saucenao' | 'fluffle'>) => {
    if (!selectedFile) return;
    try {
      setProviderState({ loading: true, error: null });
      const fileId = selectedFile.id;
      const results = await Promise.allSettled(providers.map((provider) => api.runProvider(fileId, provider)));
      await loadProviders(fileId);
      await loadTags(fileId);
      await loadSauces();
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      const error = failure
        ? failure.reason instanceof Error
          ? failure.reason.message
          : String(failure.reason)
        : null;
      setProviderState({ loading: false, error });
    } catch (err) {
      setProviderState({ loading: false, error: (err as Error).message });
    }
  };

  const onRunProvider = async (provider: 'saucenao' | 'fluffle') => {
    await runProviders([provider]);
  };

  const onRunAllProviders = async () => {
    await runProviders(['saucenao', 'fluffle']);
  };

  const activeFileList = useMemo(() => {
    if (viewMode === 'gallery') return galleryFiles;
    return [];
  }, [viewMode, galleryFiles]);

  const activeIndex = useMemo(() => {
    if (!selectedFile) return -1;
    return activeFileList.findIndex((file) => file.id === selectedFile.id);
  }, [selectedFile, activeFileList]);

  const hasPrev = activeIndex > 0;
  const hasNext = activeIndex >= 0 && (activeIndex < activeFileList.length - 1 || galleryHasMore);
  const prevLoadedFile = activeIndex > 0 ? activeFileList[activeIndex - 1] : null;
  const nextLoadedFile = activeIndex >= 0 && activeIndex < activeFileList.length - 1 ? activeFileList[activeIndex + 1] : null;

  const goRelative = useCallback(
    async (delta: number) => {
      if (!selectedFile) return;
      const idx = activeFileList.findIndex((f) => f.id === selectedFile.id);
      if (idx === -1) return;
      const next = activeFileList[idx + delta];
      if (next) {
        setSelectedFile(next);
        return;
      }
      if (delta > 0 && galleryHasMore) {
        pendingNavRef.current = delta;
        await loadGalleryPage();
      }
    },
    [selectedFile, activeFileList, galleryHasMore, loadGalleryPage]
  );

  const clearDetailSwipeTimer = useCallback(() => {
    if (detailSwipeTimerRef.current !== null) {
      window.clearTimeout(detailSwipeTimerRef.current);
      detailSwipeTimerRef.current = null;
    }
  }, []);

  const resetDetailSwipe = useCallback(() => {
    clearDetailSwipeTimer();
    detailGestureRef.current = {
      active: false,
      startX: 0,
      startY: 0,
      lastX: 0,
      startedAt: 0,
      axis: 'idle'
    };
    setDetailSwipeLocked(false);
    setDetailSwipeTransition(false);
    setDetailSwipeOffset(0);
  }, [clearDetailSwipeTimer]);

  const commitDetailSwipe = useCallback(
    (delta: -1 | 1) => {
      const targetFile = delta < 0 ? prevLoadedFile : nextLoadedFile;
      setDetailSwipeTransition(true);
      if (!targetFile) {
        setDetailSwipeOffset(0);
        clearDetailSwipeTimer();
        detailSwipeTimerRef.current = window.setTimeout(() => {
          detailSwipeTimerRef.current = null;
          setDetailSwipeTransition(false);
        }, 220);
        return;
      }
      const width = detailSwipeFrameRef.current?.clientWidth ?? window.innerWidth ?? 1;
      setDetailSwipeOffset(delta < 0 ? width : -width);
      clearDetailSwipeTimer();
      detailSwipeTimerRef.current = window.setTimeout(() => {
        detailSwipeTimerRef.current = null;
        setDetailSwipeTransition(false);
        setSelectedFile(targetFile);
        setDetailSwipeOffset(0);
      }, 220);
    },
    [clearDetailSwipeTimer, nextLoadedFile, prevLoadedFile]
  );

  const onDetailTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      if (mediaFullscreen || detailSwipeTransition || event.touches.length !== 1) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, a, input, textarea, select, label, video')) return;
      const touch = event.touches[0];
      clearDetailSwipeTimer();
      detailGestureRef.current = {
        active: true,
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        startedAt: performance.now(),
        axis: 'idle'
      };
      setDetailSwipeTransition(false);
    },
    [clearDetailSwipeTimer, detailSwipeTransition, mediaFullscreen]
  );

  const onDetailTouchMove = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      const gesture = detailGestureRef.current;
      if (!gesture.active || event.touches.length !== 1 || mediaFullscreen) return;
      const touch = event.touches[0];
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      gesture.lastX = touch.clientX;
      if (gesture.axis === 'idle') {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        gesture.axis = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'x' : 'y';
      }
      if (gesture.axis !== 'x') return;
      setDetailSwipeLocked(true);
      event.preventDefault();
      let nextOffset = dx;
      if ((dx > 0 && !prevLoadedFile) || (dx < 0 && !nextLoadedFile)) {
        nextOffset *= 0.28;
      }
      setDetailSwipeTransition(false);
      setDetailSwipeOffset(nextOffset);
    },
    [mediaFullscreen, nextLoadedFile, prevLoadedFile]
  );

  const onDetailTouchEnd = useCallback(() => {
    const gesture = detailGestureRef.current;
    if (!gesture.active) return;
    detailGestureRef.current.active = false;
    setDetailSwipeLocked(false);
    if (gesture.axis !== 'x') {
      detailGestureRef.current.axis = 'idle';
      return;
    }
    const dx = gesture.lastX - gesture.startX;
    const elapsed = Math.max(1, performance.now() - gesture.startedAt);
    const velocity = dx / elapsed;
    const width = detailSwipeFrameRef.current?.clientWidth ?? window.innerWidth ?? 1;
    const threshold = Math.min(140, width * 0.22);
    if ((dx > threshold || (dx > 28 && velocity > 0.45)) && prevLoadedFile) {
      commitDetailSwipe(-1);
      return;
    }
    if ((dx < -threshold || (dx < -28 && velocity < -0.45)) && nextLoadedFile) {
      commitDetailSwipe(1);
      return;
    }
    setDetailSwipeTransition(true);
    setDetailSwipeOffset(0);
    clearDetailSwipeTimer();
    detailSwipeTimerRef.current = window.setTimeout(() => {
      detailSwipeTimerRef.current = null;
      setDetailSwipeTransition(false);
    }, 220);
  }, [clearDetailSwipeTimer, commitDetailSwipe, nextLoadedFile, prevLoadedFile]);

  const openFile = (file: FileItem) => {
    if (!historyActiveRef.current) {
      window.history.pushState({ detail: true }, '', window.location.href);
      historyActiveRef.current = true;
    }
    setSelectedFile(file);
  };

  const closeFile = () => {
    if (historyActiveRef.current) {
      historyActiveRef.current = false;
      window.history.back();
    }
    setSelectedFile(null);
  };

  const saveSauceSettings = async (next: SauceSettings) => {
    const displayInitialized = next.displayInitialized ?? sauceSettings.displayInitialized ?? false;
    const nextSettings: SauceSettings = {
      display: next.display ?? [],
      targets: next.targets ?? [],
      displayInitialized
    };
    setSauceSettings(nextSettings);
    setSauceState({ loading: true, error: null });
    try {
      const res = await api.updateSauceSettings(nextSettings);
      setSauceSettings({
        display: res.settings.display ?? [],
        targets: res.settings.targets ?? [],
        displayInitialized: res.settings.displayInitialized ?? displayInitialized
      });
      setSauceProgress(res.progress ?? emptySauceProgress);
      setSauceState({ loading: false, error: null });
    } catch (err) {
      setSauceState({ loading: false, error: (err as Error).message });
    }
  };

  const toggleDisplaySauce = (key: string) => {
    const base = displayFilterActive
      ? new Set(sauceSettings.display.map(canonicalizeSauceKey))
      : new Set(sauceKeys.map(canonicalizeSauceKey));
    const normalized = canonicalizeSauceKey(key);
    if (base.has(normalized)) {
      base.delete(normalized);
    } else {
      base.add(normalized);
    }
    void saveSauceSettings({ display: Array.from(base), targets: sauceSettings.targets, displayInitialized: true });
  };

  const toggleTargetSauce = (key: string) => {
    const base = new Set(sauceSettings.targets.map(canonicalizeSauceKey));
    const normalized = canonicalizeSauceKey(key);
    if (base.has(normalized)) {
      base.delete(normalized);
    } else {
      base.add(normalized);
    }
    void saveSauceSettings({ display: sauceSettings.display, targets: Array.from(base) });
  };

  const setAllDisplay = (value: boolean) => {
    const next = value ? sauceKeys.map(canonicalizeSauceKey) : [];
    void saveSauceSettings({ display: next, targets: sauceSettings.targets, displayInitialized: true });
  };

  const setAllTargets = (value: boolean) => {
    const next = value ? sauceKeys.map(canonicalizeSauceKey) : [];
    void saveSauceSettings({ display: sauceSettings.display, targets: next });
  };

  useEffect(() => {
    if (!selectedFile) return;
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [selectedFile?.id]);

  useEffect(() => {
    setNavPeek(false);
    setMediaFullscreen(false);
    resetDetailSwipe();
    if (!selectedFile) return;
    setNavPeek(true);
    const timer = window.setTimeout(() => {
      setNavPeek(false);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [resetDetailSwipe, selectedFile?.id]);

  useEffect(() => {
    return () => {
      clearDetailSwipeTimer();
    };
  }, [clearDetailSwipeTimer]);

  useEffect(() => {
    if (!mediaFullscreen && !detailSwipeLocked) return;
    const bodyStyle = document.body.style;
    const htmlStyle = document.documentElement.style;
    const previousBody = {
      overflow: bodyStyle.overflow,
      overscrollBehavior: bodyStyle.overscrollBehavior
    };
    const previousHtml = {
      overflow: htmlStyle.overflow,
      overscrollBehavior: htmlStyle.overscrollBehavior
    };
    bodyStyle.overflow = 'hidden';
    bodyStyle.overscrollBehavior = 'none';
    htmlStyle.overflow = 'hidden';
    htmlStyle.overscrollBehavior = 'none';
    return () => {
      bodyStyle.overflow = previousBody.overflow;
      bodyStyle.overscrollBehavior = previousBody.overscrollBehavior;
      htmlStyle.overflow = previousHtml.overflow;
      htmlStyle.overscrollBehavior = previousHtml.overscrollBehavior;
    };
  }, [detailSwipeLocked, mediaFullscreen]);


  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!selectedFile) return;
      if (e.target instanceof HTMLElement) {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
          return;
        }
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goRelative(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goRelative(1);
      } else if (e.key === 'Escape') {
        if (mediaFullscreen) {
          setMediaFullscreen(false);
        } else {
          closeFile();
        }
      } else if (e.key === 'Delete') {
        e.preventDefault();
        void onDeleteFile(selectedFile.id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedFile, goRelative, closeFile, onDeleteFile]);

  useEffect(() => {
    const handlePopState = () => {
      if (historyActiveRef.current) {
        historyActiveRef.current = false;
        setSelectedFile(null);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const renderFileMedia = (file: FileItem) =>
    file.mediaType === 'VIDEO' ? (
      <video
        src={`${API_BASE}/files/${file.id}/content`}
        controls
        loop
        playsInline
        preload="metadata"
        className="file-detail-media"
      />
    ) : (
      <img
        src={`${API_BASE}/files/${file.id}/content`}
        alt={file.path}
        className="file-detail-media"
      />
    );

  const renderNeighborPreview = (file: FileItem | null, direction: 'prev' | 'next') => (
    <div className={`file-detail-panel file-detail-panel-preview file-detail-panel-${direction}`} aria-hidden={!file}>
      {file ? (
        <div className={`file-detail-preview-shell file-detail-layer text-light${file.mediaType === 'VIDEO' ? ' is-video' : ''}`}>
          <div className="container file-detail-back-bar">
            <button className="file-detail-back-btn file-detail-preview-control" type="button" tabIndex={-1} aria-hidden="true">
              <svg className="file-detail-back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
              {direction === 'prev' ? 'Previous file' : 'Next file'}
            </button>
            <div className="d-flex align-items-center gap-2 ms-auto file-detail-sequence-controls">
              <button className="btn btn-outline-secondary btn-sm file-detail-preview-control" type="button" tabIndex={-1} aria-hidden="true">
                ‹ Prev
              </button>
              <button className="btn btn-outline-secondary btn-sm file-detail-preview-control" type="button" tabIndex={-1} aria-hidden="true">
                Next ›
              </button>
            </div>
          </div>
          <div className="file-detail-media-wrap file-detail-media-wrap-preview">
            {renderFileMedia(file)}
            <button className="file-detail-fullscreen-btn file-detail-preview-control" type="button" aria-hidden="true" tabIndex={-1}>
              <svg className="file-detail-fullscreen-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            </button>
          </div>
          <div className="container file-detail-body file-detail-preview-body">
            <div className="file-detail-section mb-3">
              <div className="file-detail-section-head">
                <div className="text-uppercase fw-semibold file-detail-section-title file-detail-section-title-accent">
                  File info
                </div>
                <div className="file-detail-section-actions">
                  <button className="btn btn-outline-light btn-sm file-detail-download-button file-detail-icon-button file-detail-preview-control" type="button" tabIndex={-1} aria-hidden="true">
                    <svg
                      className="file-detail-download-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 3v10" />
                      <path d="M8 9l4 4 4-4" />
                      <path d="M5 21h14" />
                    </svg>
                    <span className="file-detail-button-text">Download</span>
                  </button>
                  <button className="btn btn-outline-warning btn-sm file-detail-favorite-button file-detail-icon-button file-detail-preview-control" type="button" tabIndex={-1} aria-hidden="true">
                    <svg
                      className="file-detail-favorite-icon file-detail-favorite-icon-outline"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 3.5l2.95 5.98 6.6.96-4.77 4.65 1.12 6.53L12 17.8l-5.9 3.32 1.12-6.53-4.77-4.65 6.6-.96L12 3.5z" />
                    </svg>
                    <span className="file-detail-button-text">Favorite</span>
                  </button>
                  <button className="btn btn-outline-danger btn-sm file-detail-delete-button file-detail-icon-button file-detail-preview-control" type="button" tabIndex={-1} aria-hidden="true">
                    <svg
                      className="file-detail-delete-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3 6h18" />
                      <path d="M8 6V4h8v2" />
                      <path d="M6 6l1 14h10l1-14" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                    </svg>
                    <span className="file-detail-button-text">Delete file</span>
                  </button>
                </div>
              </div>
              <div className="text-secondary small">
                <span className="fw-semibold file-detail-label">File name:</span> {basenameFromPath(file.path) || file.path}
                <br />
                {file.durationMs ? `${(file.durationMs / 1000).toFixed(1)}s` : ''}
                {file.durationMs ? <br /> : null}
                <span className="fw-semibold file-detail-label">Type:</span> {fileTypeFromPath(file.path, file.mediaType)}
                <br />
                <span className="fw-semibold file-detail-label">Size:</span> {formatSizeMb(file.sizeBytes)}
                {file.width && file.height ? ` (${file.width}×${file.height})` : ''}
                <br />
                <span className="fw-semibold file-detail-label">Modified:</span> {formatDateTime(file.mtime)}
              </div>
            </div>
            <div className="file-detail-section-divider" />
            <div className="file-detail-section mb-3">
              <div className="file-detail-section-head">
                <div className="text-uppercase fw-semibold file-detail-section-title file-detail-section-title-accent">
                  Tags
                </div>
                <div className="d-flex gap-2">
                  <button className="btn btn-outline-light btn-sm file-detail-refresh-button file-detail-icon-button file-detail-preview-control" type="button" tabIndex={-1} aria-hidden="true">
                    <svg
                      className="file-detail-refresh-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      <path d="M21 3v6h-6" />
                    </svg>
                    <span className="file-detail-button-text">Refresh</span>
                  </button>
                </div>
              </div>
              <div className="text-secondary small file-detail-preview-copy">
                Tags load when this file becomes active.
              </div>
            </div>
            <div className="file-detail-section-divider" />
            <div className="file-detail-section mb-3">
              <div className="file-detail-section-head">
                <div className="text-uppercase fw-semibold file-detail-section-title file-detail-section-title-accent">
                  Sauces
                </div>
                <button className="btn btn-outline-light btn-sm file-detail-scan-button file-detail-icon-button file-detail-preview-control" type="button" tabIndex={-1} aria-hidden="true">
                  <svg
                    className="file-detail-scan-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="6" />
                    <path d="M16 16l5 5" />
                  </svg>
                  <span className="file-detail-button-text">Scan</span>
                </button>
              </div>
              <div className="text-secondary small file-detail-preview-copy">
                Match results load when this file becomes active.
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  if (authState.loading && !authUser) {
    return (
      <div className="bg-dark text-light min-vh-100 d-flex align-items-center justify-content-center">
        <div className="text-secondary">Checking session…</div>
      </div>
    );
  }

  if (!authUser) {
    return (
      <div className="bg-dark text-light min-vh-100 d-flex align-items-center justify-content-center px-3">
        <div className="card bg-black text-light border-secondary" style={{ width: '100%', maxWidth: 420 }}>
          <div className="card-body p-4">
            <div className="d-flex justify-content-between align-items-start mb-3">
              <div>
                <h1 className="h3 mb-1">GoonCave</h1>
                <div className="text-secondary small">Local-network sign-in</div>
              </div>
              <div className="btn-group btn-group-sm" role="group" aria-label="auth mode">
                <button
                  type="button"
                  className={`btn btn-${authMode === 'login' ? 'primary' : 'outline-light'}`}
                  onClick={() => {
                    setAuthMode('login');
                    setAuthState({ loading: false, error: null });
                  }}
                >
                  Login
                </button>
                <button
                  type="button"
                  className={`btn btn-${authMode === 'register' ? 'primary' : 'outline-light'}`}
                  onClick={() => {
                    setAuthMode('register');
                    setAuthState({ loading: false, error: null });
                  }}
                >
                  Register
                </button>
              </div>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitAuth();
              }}
            >
              <div className="mb-3">
                <label className="form-label">Username</label>
                <input
                  className="form-control bg-dark text-light border-secondary"
                  value={authForm.username}
                  onChange={(event) => setAuthForm((prev) => ({ ...prev, username: event.target.value }))}
                  autoComplete="username"
                />
              </div>
              <div className="mb-3">
                <label className="form-label">Password</label>
                <input
                  className="form-control bg-dark text-light border-secondary"
                  type="password"
                  value={authForm.password}
                  onChange={(event) => setAuthForm((prev) => ({ ...prev, password: event.target.value }))}
                  autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                />
              </div>
              {authMode === 'register' ? (
                <div className="mb-3">
                  <label className="form-label">Confirm password</label>
                  <input
                    className="form-control bg-dark text-light border-secondary"
                    type="password"
                    value={authForm.confirmPassword}
                    onChange={(event) => setAuthForm((prev) => ({ ...prev, confirmPassword: event.target.value }))}
                    autoComplete="new-password"
                  />
                </div>
              ) : null}
              {authState.error ? <div className="alert alert-danger py-2">{authState.error}</div> : null}
              <button className="btn btn-primary w-100" type="submit" disabled={authState.loading}>
                {authState.loading ? 'Working…' : authMode === 'login' ? 'Login' : 'Create account'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-dark text-light min-vh-100">
      {selectedFile ? null : (
      <div className="container page-shell">
        <div className="d-flex justify-content-between align-items-center mb-3">
          <div>
            <h1 className="h3 mb-1">GoonCave</h1>
            <div className="text-secondary small">Signed in as {authUser.username}</div>
          </div>
          <div>
            <button className="btn btn-outline-light btn-sm" type="button" onClick={() => void logout()}>
              Logout
            </button>
          </div>
        </div>
        <div className="btn-group mb-4" role="group" aria-label="view switcher">
          <button
            className={`btn btn-${viewMode === 'gallery' ? 'primary' : 'outline-light'}`}
            onClick={() => void onSwitchView('gallery')}
          >
            Gallery
          </button>
          <button
            className={`btn btn-${viewMode === 'duplicates' ? 'primary' : 'outline-light'}`}
            onClick={() => void onSwitchView('duplicates')}
          >
            Duplicates
          </button>
          <button
            className={`btn btn-${viewMode === 'folders' ? 'primary' : 'outline-light'}`}
            onClick={() => void onSwitchView('folders')}
          >
            Settings
          </button>
        </div>

        {fetchState.error ? <div className="text-danger mb-3">Error: {fetchState.error}</div> : null}
        {manualOrderState.error ? <div className="text-danger mb-3">Manual order: {manualOrderState.error}</div> : null}
        {manualOrderState.loading ? <div className="text-secondary small mb-3">Saving manual order…</div> : null}
        <div className="row g-4">
          {viewMode === 'folders' ? (
            <>
              <div className="col-12">
                <div className="card bg-dark text-light border-secondary h-100">
                  <div className="card-body">
                    <div className="d-flex justify-content-between align-items-center mb-3">
                      <h2 className="h5 mb-0">Folders</h2>
                    </div>
                    <div className="folder-top-row">
                    <form
                      className="border border-secondary rounded p-3 folder-add-card"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void onAddFolder();
                      }}
                    >
                      <div className="fw-semibold mb-2">Add a folder</div>
                      <div className="text-secondary small mb-2">
                        Read the readme to add a folder in docker. then, paste the desired folder path here
                      </div>
                      <div className="d-flex flex-wrap gap-2">
                        <input
                          className="form-control form-control-sm bg-dark text-light border-secondary"
                          style={{ minWidth: 200, flex: 1 }}
                          value={folderDraft.path}
                          onChange={(event) => setFolderDraft({ path: event.target.value })}
                          placeholder="/path/to/folder"
                          disabled={folderActionState.loading}
                        />
                        <button
                          type="submit"
                          className="btn btn-success btn-sm"
                          disabled={folderActionState.loading || folderDraft.path.trim().length === 0}
                        >
                          {folderActionState.loading ? 'Adding…' : 'Add folder'}
                        </button>
                      </div>
                      {folderActionState.error ? (
                        <div className="text-danger small mt-2">Folder error: {folderActionState.error}</div>
                      ) : null}
                    </form>
                    {folders.length === 0 ? (
                      <p className="text-secondary">No folders configured.</p>
                    ) : (
                      <div className="list-group folder-list">
                        {folders.map((folder) => {
                          const isFavoritesRoot = favoritesSettings.favoritesRootId === folder.id;
                          return (
                            <div
                              key={folder.id}
                              className="list-group-item d-flex justify-content-between align-items-center bg-secondary text-light border border-secondary folder-card"
                            >
                              <div className="folder-card-body">
                                <div className="fw-semibold folder-card-path" title={folder.path}>{folder.path}</div>
                                <div className="text-secondary small">
                                  Added: {formatDateTime(folder.createdAt)} · Last scan: {formatDateTime(folder.lastScanAt)}
                                </div>
                                <div className="d-flex flex-wrap gap-2 mt-2">
                                  <span className={`badge ${statusBadge(folder.status)}`}>
                                    {folder.status.toLowerCase()}
                                  </span>
                                  {isFavoritesRoot ? (
                                    <span className="badge bg-warning text-dark">favorites sync</span>
                                  ) : null}
                                </div>
                              </div>
                              <div className="d-flex gap-2 folder-card-actions">
                                <button
                                  className={`btn btn-outline-warning btn-sm${isFavoritesRoot ? ' active' : ''}`}
                                  onClick={() => void updateFavoritesSettings({ favoritesRootId: folder.id })}
                                  disabled={favoritesSettingsState.loading}
                                  title="Use this folder for favorites sync"
                                >
                                  {isFavoritesRoot ? 'Favorites default' : 'Use for favorites'}
                                </button>
                                <button
                                  className="btn btn-outline-danger"
                                  onClick={() => void onDeleteFolder(folder)}
                                  disabled={folderActionState.loading || folder.status === 'SCANNING'}
                                >
                                  Remove
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    </div>
                  </div>
                </div>
              </div>
              <div className="col-12">
                <div className="card bg-dark text-light border-secondary h-100">
                  <div className="card-body">
                    <div className="d-flex justify-content-between align-items-center mb-2">
                      <h2 className="h5 mb-0">Sync favorites</h2>
                    </div>
                    <p className="text-secondary small mb-3">
                      Connect your e621 and Danbooru accounts to double-sync favorites.
                    </p>
                    <div className="credential-grid mb-3">
                      <div className="credential-col">
                        <div className="border border-secondary rounded p-2 credential-card">
                          <div className="d-flex justify-content-between align-items-center gap-2">
                            <div className="fw-semibold">e621</div>
                            <div className="d-flex align-items-center gap-2">
                              {e621Ready ? (
                                <>
                                  <button
                                    type="button"
                                    className="btn btn-outline-light btn-sm"
                                    onClick={() => void logoutCredential('E621')}
                                    disabled={credentialsState.loading}
                                  >
                                    Log out
                                  </button>
                                  <span className="btn btn-success btn-sm credential-status">Logged in</span>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="btn btn-outline-light btn-sm"
                                    onClick={() =>
                                      setCredentialExpanded((prev) => ({ ...prev, E621: true }))
                                    }
                                    disabled={credentialsState.loading}
                                  >
                                    Log in
                                  </button>
                                  <span className="btn btn-danger btn-sm credential-status">Logged out</span>
                                </>
                              )}
                            </div>
                          </div>
                          {!e621Ready && credentialExpanded.E621 ? (
                            <div className="mt-2 credential-fields" id="credential-e621">
                              <label className="form-label small text-secondary">Username</label>
                              <input
                                className="form-control form-control-sm mb-2"
                                value={credentialInputs.E621.username}
                                onChange={(event) => updateCredentialInput('E621', 'username', event.target.value)}
                                placeholder="Enter your e621 username"
                                disabled={credentialsState.loading}
                              />
                              <label className="form-label small text-secondary">API key</label>
                              <input
                                type="password"
                                className="form-control form-control-sm"
                                value={credentialInputs.E621.apiKey}
                                onChange={(event) => updateCredentialInput('E621', 'apiKey', event.target.value)}
                                placeholder="Enter API key"
                                disabled={credentialsState.loading}
                              />
                              <div className="d-flex align-items-center gap-2 mt-2">
                                <button
                                  className="btn btn-outline-light btn-sm"
                                  onClick={() => void saveCredential('E621')}
                                  disabled={credentialsState.loading}
                                >
                                  Save
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="credential-col">
                        <div className="border border-secondary rounded p-2 credential-card">
                          <div className="d-flex justify-content-between align-items-center gap-2">
                            <div className="fw-semibold">Danbooru</div>
                            <div className="d-flex align-items-center gap-2">
                              {danbooruReady ? (
                                <>
                                  <button
                                    type="button"
                                    className="btn btn-outline-light btn-sm"
                                    onClick={() => void logoutCredential('DANBOORU')}
                                    disabled={credentialsState.loading}
                                  >
                                    Log out
                                  </button>
                                  <span className="btn btn-success btn-sm credential-status">Logged in</span>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="btn btn-outline-light btn-sm"
                                    onClick={() =>
                                      setCredentialExpanded((prev) => ({ ...prev, DANBOORU: true }))
                                    }
                                    disabled={credentialsState.loading}
                                  >
                                    Log in
                                  </button>
                                  <span className="btn btn-danger btn-sm credential-status">Logged out</span>
                                </>
                              )}
                            </div>
                          </div>
                          {!danbooruReady && credentialExpanded.DANBOORU ? (
                            <div className="mt-2 credential-fields" id="credential-danbooru">
                              <label className="form-label small text-secondary">Username</label>
                              <input
                                className="form-control form-control-sm mb-2"
                                value={credentialInputs.DANBOORU.username}
                                onChange={(event) => updateCredentialInput('DANBOORU', 'username', event.target.value)}
                                placeholder="Enter your Danbooru username"
                                disabled={credentialsState.loading}
                              />
                              <label className="form-label small text-secondary">API key</label>
                              <input
                                type="password"
                                className="form-control form-control-sm"
                                value={credentialInputs.DANBOORU.apiKey}
                                onChange={(event) => updateCredentialInput('DANBOORU', 'apiKey', event.target.value)}
                                placeholder="Enter API key"
                                disabled={credentialsState.loading}
                              />
                              <div className="d-flex align-items-center gap-2 mt-2">
                                <button
                                  className="btn btn-outline-light btn-sm"
                                  onClick={() => void saveCredential('DANBOORU')}
                                  disabled={credentialsState.loading}
                                >
                                  Save
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    {credentialsState.error &&
                    (credentialLastProvider === null ||
                      credentialLastProvider === 'E621' ||
                      credentialLastProvider === 'DANBOORU') ? (
                      <div className="text-danger small mb-2">Credentials error: {credentialsState.error}</div>
                    ) : null}
                    <div className="d-flex flex-wrap gap-2 mb-2">
                      <button
                        className="btn btn-outline-light btn-sm"
                        onClick={() => void runFavoritesSync(true)}
                        disabled={favoritesSyncState.loading}
                      >
                        Sync favorites
                      </button>
                    </div>
                    <div className="form-check form-switch mb-2">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="auto-sync-toggle"
                        checked={favoritesSettings.autoSyncMidnight}
                        onChange={(event) => void updateFavoritesSettings({ autoSyncMidnight: event.target.checked })}
                        disabled={favoritesSettingsState.loading}
                      />
                      <label className="form-check-label text-secondary small" htmlFor="auto-sync-toggle">
                        Run a daily sync at midnight to keep favorites current
                      </label>
                    </div>
                    <div className="form-check form-switch mb-2">
                      <input
                        className="form-check-input"
                        type="checkbox"
                        id="reverse-sync-toggle"
                        checked={favoritesSettings.reverseSyncEnabled}
                        onChange={(event) => void updateFavoritesSettings({ reverseSyncEnabled: event.target.checked })}
                        disabled={favoritesSettingsState.loading}
                      />
                      <label className="form-check-label text-secondary small" htmlFor="reverse-sync-toggle">
                        When you delete a file here, also remove it from favorites
                      </label>
                    </div>
                    {favoritesSettingsState.error ? (
                      <div className="text-danger small">Settings error: {favoritesSettingsState.error}</div>
                    ) : null}
                    {favoritesSyncState.loading || favoritesSyncStatus?.status === 'running' ? (
                      <div className="text-secondary small">
                        {favoritesSyncStatus?.message ?? 'Syncing favorites…'}
                      </div>
                    ) : null}
                    {favoritesSyncStatus ? (
                      <div className="text-secondary small mt-1">
                        <div>Last sync started: {formatDateTime(favoritesSyncStatus.startedAt)}</div>
                        <div>Last sync updated: {formatDateTime(favoritesSyncStatus.updatedAt)}</div>
                      </div>
                    ) : null}
                    {favoritesSyncState.error ? (
                      <div className="text-danger small">Error: {favoritesSyncState.error}</div>
                    ) : null}
                    {favoritesSyncStatus?.status === 'running' && favoritesProgress !== null ? (
                      <div className="progress bg-dark border border-secondary mt-2" style={{ height: 8 }}>
                        <div
                          className="progress-bar bg-info"
                          role="progressbar"
                          style={{ width: `${favoritesProgress}%` }}
                          aria-valuenow={favoritesProgress}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        />
                      </div>
                    ) : null}
                    {favoritesSyncStatus?.progress?.providers?.length ? (
                      <div className="text-secondary small mt-2">
                        {favoritesSyncStatus.progress.providers.map((entry) => (
                          <div key={entry.provider}>
                            {entry.provider}: {entry.stage} · {entry.processed}/{entry.total} · +{entry.added} / -
                            {entry.removed}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {favoritesSummary.length ? (
                      <div className="text-secondary small">
                        {favoritesSummary.map((line) => (
                          <div key={line}>{line}</div>
                        ))}
                      </div>
                    ) : null}
                    {favoritesErrors.length ? (
                      <div className="text-danger small mt-2">
                        {favoritesErrors.slice(0, 6).map((line) => (
                          <div key={line}>{line}</div>
                        ))}
                        {favoritesErrors.length > 6 ? (
                          <div>…and {favoritesErrors.length - 6} more errors</div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="col-12">
                <div className="card bg-dark text-light border-secondary h-100">
                  <div className="card-body">
                    <div className="d-flex justify-content-between align-items-center mb-2">
                      <h2 className="h5 mb-0">Sauces</h2>
                    </div>
                    <p className="text-secondary small mb-3">
                      Pick which sources appear in the file view and which ones the scanner should look for
                      automatically. Targeted sources are retried daily for up to a week or until a match is found.
                    </p>
                    <div className="border border-secondary rounded p-2 mb-3 credential-card">
                      <div className="d-flex justify-content-between align-items-center gap-2">
                        <div className="fw-semibold">SauceNAO</div>
                        <div className="d-flex align-items-center gap-2">
                          {saucenaoReady ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-outline-light btn-sm"
                                onClick={() => void logoutCredential('SAUCENAO')}
                                disabled={credentialsState.loading}
                              >
                                Log out
                              </button>
                              <span className="btn btn-success btn-sm credential-status">Logged in</span>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="btn btn-outline-light btn-sm"
                                onClick={() =>
                                  setCredentialExpanded((prev) => ({ ...prev, SAUCENAO: true }))
                                }
                                disabled={credentialsState.loading}
                              >
                                Log in
                              </button>
                              <span className="btn btn-danger btn-sm credential-status">Logged out</span>
                            </>
                          )}
                        </div>
                      </div>
                      {!saucenaoReady && credentialExpanded.SAUCENAO ? (
                        <div className="mt-2 credential-fields" id="credential-saucenao">
                          <label className="form-label small text-secondary">Username</label>
                          <input
                            className="form-control form-control-sm mb-2"
                            value=""
                            placeholder="Not used for SauceNAO"
                            disabled
                          />
                          <label className="form-label small text-secondary">API key</label>
                          <input
                            type="password"
                            className="form-control form-control-sm"
                            value={credentialInputs.SAUCENAO.apiKey}
                            onChange={(event) => updateCredentialInput('SAUCENAO', 'apiKey', event.target.value)}
                            placeholder="Enter API key"
                            disabled={credentialsState.loading}
                          />
                          <div className="d-flex align-items-center gap-2 mt-2">
                            <button
                              className="btn btn-outline-light btn-sm"
                              onClick={() => void saveCredential('SAUCENAO')}
                              disabled={credentialsState.loading}
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    {credentialsState.error && credentialLastProvider === 'SAUCENAO' ? (
                      <div className="text-danger small mb-2">Credentials error: {credentialsState.error}</div>
                    ) : null}
                    <div className="sauce-progress-wrap mb-3">
                      <div className="sauce-progress-bar border border-secondary bg-dark" role="img" aria-label="Sauce target scan progress">
                        <div
                          className="sauce-progress-segment bg-success"
                          style={{ width: `${sauceProgressSegments.matched}%` }}
                        />
                        <div
                          className="sauce-progress-segment bg-danger"
                          style={{ width: `${sauceProgressSegments.failed}%` }}
                        />
                        <div
                          className="sauce-progress-segment sauce-progress-segment-pending"
                          style={{ width: `${sauceProgressSegments.pending}%` }}
                        />
                      </div>
                      <div className="sauce-progress-legend text-secondary small mt-2">
                        <span className="sauce-progress-legend-item">
                          <span className="sauce-progress-dot bg-success" />
                          Target found ({sauceProgress.matched})
                        </span>
                        <span className="sauce-progress-legend-item">
                          <span className="sauce-progress-dot bg-danger" />
                          Failed ({sauceProgress.failed})
                        </span>
                        <span className="sauce-progress-legend-item">
                          <span className="sauce-progress-dot sauce-progress-dot-pending" />
                          Pending ({sauceProgress.pending})
                        </span>
                      </div>
                      <hr className="sauce-progress-separator" />
                    </div>
                    {sauceState.error ? <div className="text-danger mb-2">Error: {sauceState.error}</div> : null}
                    {sauceSources.length === 0 ? (
                      <p className="text-secondary">No sources discovered yet.</p>
                    ) : (
                      <>
                        <div className="d-flex flex-wrap gap-2 mb-3">
                          <button className="btn btn-outline-light btn-sm" onClick={() => setAllDisplay(true)}>
                            Show all
                          </button>
                          <button className="btn btn-outline-light btn-sm" onClick={() => setAllDisplay(false)}>
                            Show none
                          </button>
                          <button className="btn btn-outline-light btn-sm" onClick={() => setAllTargets(true)}>
                            Target all
                          </button>
                          <button className="btn btn-outline-light btn-sm" onClick={() => setAllTargets(false)}>
                            Clear targets
                          </button>
                        </div>
                        <div className="table-responsive">
                          <table className="table table-dark table-sm align-middle mb-0">
                            <thead>
                              <tr>
                                <th>Source</th>
                                <th className="text-center">Show</th>
                                <th className="text-center">Target</th>
                                <th className="text-end">Hits</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sauceSources.map((source) => {
                                const key = canonicalizeSauceKey(source.key);
                                const displayChecked = displaySet.has(key);
                                const targetChecked = targetSet.has(key);
                                return (
                                  <tr key={source.key}>
                                    <td>{source.label}</td>
                                    <td className="text-center">
                                      <input
                                        type="checkbox"
                                        className="form-check-input"
                                        checked={displayChecked}
                                        onChange={() => toggleDisplaySauce(key)}
                                      />
                                    </td>
                                    <td className="text-center">
                                      <input
                                        type="checkbox"
                                        className="form-check-input"
                                        checked={targetChecked}
                                        onChange={() => toggleTargetSauce(key)}
                                      />
                                    </td>
                                    <td className="text-end text-secondary">{source.count}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : viewMode === 'duplicates' ? (
            <div className="col-12">
              <div className="card bg-dark text-light border-secondary h-100">
                <div className="card-body">
                  <div className="d-flex justify-content-between align-items-center mb-3">
                    {duplicateStats ? (
                      <span className="text-secondary small">{duplicateGroups.length} groups</span>
                    ) : null}
                  </div>
                  <p className="text-secondary small mb-3">
                    Groups files by media type and dimensions, then compares downscaled pixels (videos use sampled frames).
                  </p>
                  <div className="form-check form-switch mb-3">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="duplicate-auto-resolve-toggle"
                      checked={duplicateSettings.autoResolve}
                      onChange={(event) => void updateDuplicateSettings({ autoResolve: event.target.checked })}
                      disabled={duplicateSettingsState.loading}
                    />
                    <label className="form-check-label text-secondary small" htmlFor="duplicate-auto-resolve-toggle">
                      Auto-resolve duplicates (prefer synced favorites, then quality)
                    </label>
                  </div>
                  {duplicateSettingsState.error ? (
                    <div className="text-danger mb-2">Settings error: {duplicateSettingsState.error}</div>
                  ) : null}
                  <div className="d-flex flex-wrap gap-3 align-items-end mb-3">
                    <div>
                      <div className="text-secondary small mb-1">Media</div>
                      <select
                        className="form-select form-select-sm bg-dark text-light border-secondary"
                        value={duplicateOptions.mediaType ?? 'ALL'}
                        onChange={(event) =>
                          setDuplicateOptions((prev) => ({
                            ...prev,
                            mediaType: event.target.value as DuplicateScanOptions['mediaType']
                          }))
                        }
                      >
                        <option value="ALL">All</option>
                        <option value="IMAGE">Images</option>
                        <option value="VIDEO">Videos</option>
                      </select>
                    </div>
                    <div>
                      <div className="text-secondary small mb-1">Pixel threshold</div>
                      <input
                        className="form-control form-control-sm bg-dark text-light border-secondary"
                        type="number"
                        step="0.01"
                        min={0}
                        max={0.2}
                        value={duplicateOptions.pixelThreshold ?? 0.02}
                        onChange={(event) =>
                          setDuplicateOptions((prev) => ({
                            ...prev,
                            pixelThreshold: clamp(toNumberOr(event.target.value, prev.pixelThreshold ?? 0.02), 0, 0.2)
                          }))
                        }
                      />
                    </div>
                    <div>
                      <div className="text-secondary small mb-1">Sample size</div>
                      <input
                        className="form-control form-control-sm bg-dark text-light border-secondary"
                        type="number"
                        step="8"
                        min={8}
                        max={256}
                        value={duplicateOptions.sampleSize ?? 64}
                        onChange={(event) =>
                          setDuplicateOptions((prev) => ({
                            ...prev,
                            sampleSize: clamp(
                              Number.parseInt(event.target.value, 10) || (prev.sampleSize ?? 64),
                              8,
                              256
                            )
                          }))
                        }
                      />
                    </div>
                    <div>
                      <div className="text-secondary small mb-1">Video frames</div>
                      <input
                        className="form-control form-control-sm bg-dark text-light border-secondary"
                        type="number"
                        step="1"
                        min={1}
                        max={8}
                        value={duplicateOptions.videoFrames ?? 3}
                        onChange={(event) =>
                          setDuplicateOptions((prev) => ({
                            ...prev,
                            videoFrames: clamp(
                              Number.parseInt(event.target.value, 10) || (prev.videoFrames ?? 3),
                              1,
                              8
                            )
                          }))
                        }
                      />
                    </div>
                    <div>
                      <div className="text-secondary small mb-1">Max comparisons</div>
                      <input
                        className="form-control form-control-sm bg-dark text-light border-secondary"
                        type="number"
                        step="100"
                        min={1}
                        max={100000}
                        value={duplicateOptions.maxComparisons ?? 2000}
                        onChange={(event) =>
                          setDuplicateOptions((prev) => ({
                            ...prev,
                            maxComparisons: clamp(
                              Number.parseInt(event.target.value, 10) || (prev.maxComparisons ?? 2000),
                              1,
                              100000
                            )
                          }))
                        }
                      />
                    </div>
                    <button
                      className="btn btn-outline-light btn-sm"
                      onClick={() => void loadDuplicates()}
                      disabled={duplicateState.loading}
                    >
                      {duplicateState.loading ? 'Scanning…' : 'Run scan'}
                    </button>
                  </div>
                  {duplicateState.error ? <div className="text-danger mb-2">Error: {duplicateState.error}</div> : null}
                  {duplicateState.loading && duplicateScanStatus?.progress ? (
                    <div className="mb-3">
                      <div className="d-flex justify-content-between text-secondary small mb-1">
                        <span>{duplicateScanStatus.progress.message}</span>
                        <span>
                          {duplicateScanStatus.progress.total > 0
                            ? `${Math.min(
                                100,
                                Math.round(
                                  (duplicateScanStatus.progress.processed / duplicateScanStatus.progress.total) * 100
                                )
                              )}%`
                            : 'working'}
                        </span>
                      </div>
                      <div className="progress bg-secondary bg-opacity-25" role="progressbar" aria-valuemin={0} aria-valuemax={100}>
                        <div
                          className="progress-bar progress-bar-striped progress-bar-animated"
                          style={{
                            width:
                              duplicateScanStatus.progress.total > 0
                                ? `${Math.min(
                                    100,
                                    Math.round(
                                      (duplicateScanStatus.progress.processed / duplicateScanStatus.progress.total) * 100
                                    )
                                  )}%`
                                : '100%'
                          }}
                        />
                      </div>
                      <div className="text-secondary small mt-1">
                        Phase: {duplicateScanStatus.progress.phase} · Processed {duplicateScanStatus.progress.processed}/
                        {duplicateScanStatus.progress.total} · Comparisons {duplicateScanStatus.progress.comparisons} · Groups{' '}
                        {duplicateScanStatus.progress.groups} · Skipped {duplicateScanStatus.progress.skippedNoSignature}
                      </div>
                    </div>
                  ) : null}
                  {duplicateAction.error ? (
                    <div className="text-danger mb-2">Delete error: {duplicateAction.error}</div>
                  ) : null}
                  {duplicateStats ? (
                    <div className="text-secondary small mb-3">
                      Eligible: {duplicateStats.eligibleFiles}/{duplicateStats.totalFiles} · Compared:{' '}
                      {duplicateStats.comparedFiles} · Comparisons: {duplicateStats.comparisons} · Skipped:{' '}
                      {duplicateStats.skippedNoSignature}
                    </div>
                  ) : null}
                  {duplicatePairs.length === 0 ? (
                    <p className="text-secondary">
                      {duplicateState.loading
                        ? 'Scanning duplicates…'
                        : duplicateStats
                          ? 'No duplicates found.'
                          : 'Run a scan to check for duplicates.'}
                    </p>
                  ) : (
                    duplicatePairs.map((pair, index) => {
                      const leftSuggested = !!pair.suggestedKeepId && pair.suggestedKeepId === pair.left.id;
                      const rightSuggested = !!pair.suggestedKeepId && pair.suggestedKeepId === pair.right.id;
                      const suggestedSide = pair.suggestedKeepId ? (leftSuggested ? 'left' : 'right') : 'both';
                      const actionBusy =
                        duplicateAction.loadingId === pair.left.id || duplicateAction.loadingId === pair.right.id;
                      return (
                        <div key={pair.key} className="duplicate-pair border border-secondary rounded p-3 mb-3">
                          <div className="d-flex justify-content-between align-items-center mb-2">
                            <div className="text-secondary small">Pair {index + 1}</div>
                            <div className="text-secondary small">
                              Suggested: keep {suggestedSide} ({pair.reason})
                            </div>
                          </div>
                          <div className="row g-3">
                            <div className="col-md-6">{renderDuplicateCard(pair.left, leftSuggested, pair.reason)}</div>
                            <div className="col-md-6">
                              {renderDuplicateCard(pair.right, rightSuggested, pair.reason)}
                            </div>
                          </div>
                          <div className="d-flex flex-wrap gap-2 mt-3">
                            <button
                              className="btn btn-success btn-sm"
                              onClick={() => void resolveDuplicateChoice(pair.left, pair.right)}
                              disabled={actionBusy}
                            >
                              Keep left
                            </button>
                            <button
                              className="btn btn-success btn-sm"
                              onClick={() => void resolveDuplicateChoice(pair.right, pair.left)}
                              disabled={actionBusy}
                            >
                              Keep right
                            </button>
                            <button
                              className="btn btn-outline-light btn-sm"
                              onClick={() => resolveDuplicateKeepBoth(pair.key)}
                              disabled={actionBusy}
                            >
                              Keep both
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="col-12">
              <div className="card bg-dark text-light border-secondary h-100">
                <div className="card-body">
                  <div className="gallery-controls d-flex flex-wrap align-items-center mb-2">
                    <div className="gallery-control-group gallery-control-search d-flex flex-wrap align-items-center gap-2">
                      <span className="text-secondary small">Search for tags:</span>
                      <input
                        className="form-control form-control-sm bg-dark text-light border-secondary gallery-control-search-input"
                        placeholder="Filter by tags (space or comma separated)"
                        value={galleryTagInput}
                        onChange={(event) => setGalleryTagInput(event.target.value)}
                      />
                      {galleryTagInput ? (
                        <button
                          className="btn btn-outline-light btn-sm"
                          onClick={() => {
                            setGalleryTagInput('');
                            setGalleryTagQuery('');
                          }}
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>
                    <span className="gallery-control-separator" aria-hidden="true" />
                    <div className="gallery-control-group d-flex align-items-center gap-2">
                      <span className="text-secondary small">Order by:</span>
                      <div className="btn-group btn-group-sm" role="group">
                        <button
                          className={`btn btn-${gallerySort === 'manual' ? 'primary' : 'outline-light'}`}
                          onClick={() => void applyGallerySort('manual')}
                        >
                          Manual
                        </button>
                        <button
                          className={`btn btn-${gallerySort === 'mtime_desc' ? 'primary' : 'outline-light'}`}
                          onClick={() => void applyGallerySort('mtime_desc')}
                        >
                          Newest
                        </button>
                        <button
                          className={`btn btn-${gallerySort === 'mtime_asc' ? 'primary' : 'outline-light'}`}
                          onClick={() => void applyGallerySort('mtime_asc')}
                        >
                          Oldest
                        </button>
                        <button
                          className={`btn btn-${gallerySort === 'random' ? 'primary' : 'outline-light'}`}
                          onClick={() => void applyGallerySort('random')}
                        >
                          Random
                        </button>
                      </div>
                    </div>
                    <span className="gallery-control-separator" aria-hidden="true" />
                    <div className="gallery-control-group d-flex align-items-center gap-2">
                      <span className="text-secondary small">Filters:</span>
                      <div className="dropdown" ref={galleryFilterRef}>
                        <button
                          className="btn btn-outline-light btn-sm dropdown-toggle"
                          type="button"
                          aria-expanded={isGalleryFilterOpen}
                          onClick={() => setIsGalleryFilterOpen((prev) => !prev)}
                        >
                          {galleryFilterLabel}
                        </button>
                        <div className={`dropdown-menu dropdown-menu-dark p-3${isGalleryFilterOpen ? ' show' : ''}`}>
                          <div className="form-check mb-2">
                            <input
                              className="form-check-input"
                              type="checkbox"
                              id="gallery-filter-photos"
                              checked={galleryFilters.photos}
                              onChange={() =>
                                setGalleryFilters((prev) => ({ ...prev, photos: !prev.photos }))
                              }
                            />
                            <label className="form-check-label" htmlFor="gallery-filter-photos">
                              Photos
                            </label>
                          </div>
                          <div className="form-check mb-2">
                            <input
                              className="form-check-input"
                              type="checkbox"
                              id="gallery-filter-videos"
                              checked={galleryFilters.videos}
                              onChange={() =>
                                setGalleryFilters((prev) => ({ ...prev, videos: !prev.videos }))
                              }
                            />
                            <label className="form-check-label" htmlFor="gallery-filter-videos">
                              Videos
                            </label>
                          </div>
                          <div className="form-check">
                            <input
                              className="form-check-input"
                              type="checkbox"
                              id="gallery-filter-favorites"
                              checked={galleryFilters.favorites}
                              onChange={() =>
                                setGalleryFilters((prev) => ({ ...prev, favorites: !prev.favorites }))
                              }
                            />
                            <label className="form-check-label" htmlFor="gallery-filter-favorites">
                              Favorites
                            </label>
                          </div>
                        </div>
                      </div>
                    </div>
                    <span className="gallery-control-separator" aria-hidden="true" />
                    <div className="gallery-control-group ms-auto">
                      <span className="text-secondary small">{galleryCountText} items</span>
                    </div>
                  </div>
                  <hr className="border-secondary my-3" />
                  {galleryPageState.error ? (
                    <div className="text-danger small mb-2">Gallery: {galleryPageState.error}</div>
                  ) : null}
                  {galleryFiles.length === 0 ? (
                    <p className="text-secondary">
                      {galleryPageState.loading ? 'Loading files…' : 'No files yet. Add a folder to start auto-scan.'}
                    </p>
                  ) : (
                    <>
                      <div className="row row-cols-2 row-cols-md-4 g-3">
                        {galleryFiles.map((file) => (
                          <div key={file.id} className="col">
                            <div
                              className={`gallery-card h-100${gallerySort === 'manual' ? ' gallery-item-manual' : ''}${
                                draggingId === file.id ? ' gallery-item-dragging' : ''
                              }${dragOverId === file.id && draggingId !== file.id ? ' gallery-item-drop-target' : ''}`}
                              role="button"
                              draggable={gallerySort === 'manual'}
                              onDragStart={(event) => {
                                if (gallerySort !== 'manual') return;
                                dragActiveRef.current = true;
                                setDraggingId(file.id);
                                event.dataTransfer.effectAllowed = 'move';
                                try {
                                  event.dataTransfer.setData('text/plain', file.id);
                                } catch {
                                  // no-op
                                }
                              }}
                              onDragEnd={() => {
                                dragActiveRef.current = true;
                                window.setTimeout(() => {
                                  dragActiveRef.current = false;
                                }, 0);
                                setDraggingId(null);
                                setDragOverId(null);
                              }}
                              onDragOver={(event) => {
                                if (gallerySort !== 'manual') return;
                                event.preventDefault();
                                if (dragOverId !== file.id) setDragOverId(file.id);
                              }}
                              onDrop={(event) => {
                                if (gallerySort !== 'manual') return;
                                event.preventDefault();
                                const sourceId = draggingId ?? event.dataTransfer.getData('text/plain');
                                if (sourceId) {
                                  moveManualItem(sourceId, file.id);
                                }
                                dragActiveRef.current = true;
                                window.setTimeout(() => {
                                  dragActiveRef.current = false;
                                }, 0);
                                setDraggingId(null);
                                setDragOverId(null);
                              }}
                              onClick={() => {
                                if (dragActiveRef.current) return;
                                openFile(file);
                              }}
                            >
                              {file.thumbUrl ? (
                                <img
                                  src={`${API_BASE}${file.thumbUrl}`}
                                  alt={file.path}
                                  className="img-fluid mb-2 rounded"
                                  style={{ maxHeight: 220, objectFit: 'contain', width: '100%' }}
                                  loading="lazy"
                                  decoding="async"
                                  fetchPriority="low"
                                />
                              ) : (
                                <div
                                  className="mb-2 rounded d-flex align-items-center justify-content-center bg-dark"
                                  style={{ height: 220 }}
                                >
                                  <span className="text-secondary small">{file.mediaType.toLowerCase()}</span>
                                </div>
                              )}
                              <div className="text-secondary small">
                                {file.durationMs ? `${(file.durationMs / 1000).toFixed(1)}s` : ''}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      {galleryHasMore ? (
                        <div className="d-flex justify-content-center mt-3">
                          <button
                            className="btn btn-outline-light btn-sm"
                            onClick={() => void loadGalleryPage()}
                            disabled={galleryPageState.loading}
                          >
                            {galleryPageState.loading ? 'Loading…' : 'Load more'}
                          </button>
                        </div>
                      ) : null}
                      <div ref={galleryLoadMoreRef} className="gallery-load-sentinel" />
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
      )}
      {selectedFile ? (
        <div
          ref={detailSwipeFrameRef}
          className={`file-detail-frame${mediaFullscreen ? ' is-fullscreen' : ''}`}
          onTouchStart={onDetailTouchStart}
          onTouchMove={onDetailTouchMove}
          onTouchEnd={onDetailTouchEnd}
          onTouchCancel={onDetailTouchEnd}
        >
          <div
            className={`file-detail-track${detailSwipeTransition ? ' is-transitioning' : ''}`}
            style={{ transform: `translate3d(calc(-100% + ${detailSwipeOffset}px), 0, 0)` }}
          >
            {renderNeighborPreview(prevLoadedFile, 'prev')}
            <div className={`file-detail-panel file-detail-panel-current file-detail-layer text-light${selectedFile.mediaType === 'VIDEO' ? ' is-video' : ''}`}>
              <div className="container file-detail-back-bar">
                <button className="file-detail-back-btn" onClick={closeFile}>
                  <svg className="file-detail-back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                  Back to gallery
                </button>
                <div className="d-flex align-items-center gap-2 ms-auto file-detail-sequence-controls">
                  <button
                    className="btn btn-outline-secondary btn-sm"
                    onClick={() => goRelative(-1)}
                    disabled={!hasPrev}
                    aria-label="Previous"
                  >
                    ‹ Prev
                  </button>
                  <button
                    className="btn btn-outline-secondary btn-sm"
                    onClick={() => goRelative(1)}
                    disabled={!hasNext}
                    aria-label="Next"
                  >
                    Next ›
                  </button>
                </div>
              </div>
              <div
                className={`file-detail-media-wrap${mediaFullscreen ? ' is-fullscreen' : ''}`}
                onClick={(e) => {
                  if (mediaFullscreen && e.target === e.currentTarget) setMediaFullscreen(false);
                }}
              >
                <button
                  className={`file-detail-nav file-detail-nav-left${navPeek ? ' file-detail-nav-peek' : ''}`}
                  onClick={() => goRelative(-1)}
                  disabled={!hasPrev}
                  aria-label="Previous"
                >
                  ‹
                </button>
                <button
                  className={`file-detail-nav file-detail-nav-right${navPeek ? ' file-detail-nav-peek' : ''}`}
                  onClick={() => goRelative(1)}
                  disabled={!hasNext}
                  aria-label="Next"
                >
                  ›
                </button>
                {renderFileMedia(selectedFile)}
                <button
                  className="file-detail-fullscreen-btn"
                  onClick={() => setMediaFullscreen(!mediaFullscreen)}
                  aria-label={mediaFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
                  title={mediaFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
                >
                  <svg className="file-detail-fullscreen-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {mediaFullscreen ? (
                      <>
                        <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                        <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                        <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                        <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                      </>
                    ) : (
                      <>
                        <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                        <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                        <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                        <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                      </>
                    )}
                  </svg>
                </button>
              </div>
              <div className="container file-detail-body">
            <div className="file-detail-section mb-3">
              <div className="file-detail-section-head">
                <div className="text-uppercase fw-semibold file-detail-section-title file-detail-section-title-accent">
                  File info
                </div>
                <div className="file-detail-section-actions">
                  <button
                    className="btn btn-outline-light btn-sm file-detail-download-button file-detail-icon-button"
                    disabled={shareState.loading}
                    onClick={() => void onDownloadFile()}
                    aria-label="Download file"
                    title="Download file"
                  >
                    <svg
                      className="file-detail-download-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 3v10" />
                      <path d="M8 9l4 4 4-4" />
                      <path d="M5 21h14" />
                    </svg>
                    <span className="file-detail-button-text">Download</span>
                  </button>
                  <button
                    className={`btn btn-outline-warning btn-sm file-detail-favorite-button file-detail-icon-button${
                      selectedFileFavorite ? ' is-favorite' : ''
                    }`}
                    disabled={favoriteState.loading}
                    onClick={() => void onToggleFavorite()}
                    aria-label={selectedFileFavorite ? 'Unfavorite file' : 'Favorite file'}
                    aria-pressed={selectedFileFavorite}
                    title={selectedFileFavorite ? 'Unfavorite file' : 'Favorite file'}
                  >
                    <svg
                      className="file-detail-favorite-icon file-detail-favorite-icon-outline"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 3.5l2.95 5.98 6.6.96-4.77 4.65 1.12 6.53L12 17.8l-5.9 3.32 1.12-6.53-4.77-4.65 6.6-.96L12 3.5z" />
                    </svg>
                    <svg
                      className="file-detail-favorite-icon file-detail-favorite-icon-filled"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 3.5l2.95 5.98 6.6.96-4.77 4.65 1.12 6.53L12 17.8l-5.9 3.32 1.12-6.53-4.77-4.65 6.6-.96L12 3.5z" />
                    </svg>
                    <span className="file-detail-button-text">Favorite</span>
                  </button>
                  <button
                    className="btn btn-outline-danger btn-sm file-detail-delete-button file-detail-icon-button"
                    disabled={deleteState.loading}
                    onClick={() => void onDeleteFile(selectedFile.id)}
                    aria-label={deleteState.loading ? 'Deleting file' : 'Delete file'}
                    title="Delete file"
                  >
                    <svg
                      className="file-detail-delete-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3 6h18" />
                      <path d="M8 6V4h8v2" />
                      <path d="M6 6l1 14h10l1-14" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                    </svg>
                    <span className="file-detail-button-text">Delete file</span>
                  </button>
                </div>
              </div>
              <div className="text-secondary small">
                <span className="fw-semibold file-detail-label">File name:</span> {selectedFileName}
                <br />
                {selectedFile.durationMs ? `${(selectedFile.durationMs / 1000).toFixed(1)}s` : ''}
                {selectedFile.durationMs ? <br /> : null}
                <span className="fw-semibold file-detail-label">Type:</span> {selectedFileType}
                <br />
                <span className="fw-semibold file-detail-label">Size:</span>{' '}
                {(selectedFile.sizeBytes / 1024 / 1024).toFixed(2)} MB
                {selectedFile.width && selectedFile.height ? ` (${selectedFile.width}×${selectedFile.height})` : ''}
                <br />
                <span className="fw-semibold file-detail-label">Modified:</span> {formatDateTime(selectedFile.mtime)}
              </div>
            </div>
            <div className="file-detail-section-divider" />
            <div className="file-detail-tags file-detail-section mb-3">
              <div className="d-flex justify-content-between align-items-center mb-2">
                <div className="text-uppercase fw-semibold file-detail-section-title file-detail-section-title-accent">
                  Tags
                </div>
                <div className="d-flex gap-2">
                  <button
                    className={`btn btn-outline-light btn-sm file-detail-refresh-button file-detail-icon-button${
                      tagState.loading ? ' is-loading' : ''
                    }`}
                    onClick={() => void refreshTags()}
                    disabled={tagState.loading}
                    aria-label="Refresh tags"
                  >
                    <svg
                      className="file-detail-refresh-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      <path d="M21 3v6h-6" />
                    </svg>
                    <span className="file-detail-button-text">Refresh</span>
                  </button>
                </div>
              </div>
              <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
                <input
                  className="form-control form-control-sm bg-dark text-light border-secondary"
                  style={{ maxWidth: 220 }}
                  placeholder="Add tag"
                  value={manualTagInput}
                  onChange={(event) => setManualTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void addManualTag();
                    }
                  }}
                />
                <select
                  className="form-select form-select-sm bg-dark text-light border-secondary"
                  style={{ maxWidth: 160 }}
                  value={manualTagCategory}
                  onChange={(event) => setManualTagCategory(event.target.value)}
                >
                  <option value="general">general</option>
                  <option value="artist">artist</option>
                  <option value="character">character</option>
                  <option value="copyright">copyright</option>
                  <option value="species">species</option>
                  <option value="meta">meta</option>
                  <option value="lore">lore</option>
                  <option value="invalid">invalid</option>
                </select>
                <button className="btn btn-outline-light btn-sm" onClick={() => void addManualTag()}>
                  Add
                </button>
              </div>
              {tagState.error ? <div className="text-danger small mb-2">{tagState.error}</div> : null}
              {tagState.loading ? <div className="text-secondary small mb-2">Updating tags…</div> : null}
              {tagGroups.length === 0 ? (
                <div className="text-secondary small">No tags yet.</div>
              ) : (
                tagGroups.map((group) => (
                  <div key={group.category} className="mb-2">
                    <div className="small fw-semibold text-uppercase mb-1 file-detail-subtitle">
                      {group.category}
                    </div>
                    <div className="d-flex flex-wrap gap-2">
                      {group.tags.map((tag) => {
                        const sources = Array.from(tag.sources).join(', ');
                        const scoreText = tag.score !== null ? `score ${tag.score}` : 'score n/a';
                        return (
                          <span
                            key={`${group.category}-${tag.tag}`}
                            className="badge bg-secondary text-light file-tag-pill"
                            title={`${sources} • ${scoreText}`}
                          >
                            {tag.tag}
                            {tag.hasManual ? (
                              <button
                                className="btn btn-link btn-sm p-0 ms-2 text-light file-tag-remove"
                                onClick={() => void removeManualTag(tag.tag, group.category)}
                                aria-label={`Remove ${tag.tag}`}
                              >
                                ×
                              </button>
                            ) : null}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
              <div className="text-secondary small mt-2">
                <span className="file-detail-label">Sources:</span> {tagSourceSummary}
              </div>
            </div>
            <div className="file-detail-section-divider" />
            <div className="file-detail-section mb-3">
              <div className="file-detail-section-head">
                <div className="text-uppercase fw-semibold file-detail-section-title file-detail-section-title-accent">
                  Sauces
                </div>
                <button
                  className="btn btn-outline-light btn-sm file-detail-scan-button file-detail-icon-button"
                  disabled={providerState.loading}
                  onClick={() => void onRunAllProviders()}
                  aria-label="Scan with SauceNAO and Fluffle"
                >
                  <svg
                    className="file-detail-scan-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="6" />
                    <path d="M16 16l5 5" />
                  </svg>
                  <span className="file-detail-button-text">Scan</span>
                </button>
              </div>
              {showProviderRunButtons ? (
                <div className="d-flex flex-wrap gap-2 mb-2">
                  <button
                    className="btn btn-outline-light w-100"
                    disabled={providerState.loading}
                    onClick={() => void onRunProvider('saucenao')}
                  >
                    {providerState.loading ? 'Running...' : 'SauceNAO'}
                  </button>
                  <button
                    className="btn btn-outline-light w-100"
                    disabled={providerState.loading}
                    onClick={() => void onRunProvider('fluffle')}
                  >
                    {providerState.loading ? 'Running...' : 'Fluffle'}
                  </button>
                </div>
              ) : null}
              <div className="text-secondary small mb-3">
                <div>
                  <span className="fw-semibold file-detail-label">Provider scans:</span>{' '}
                  {providerMeta?.hasRuns ? `last run ${formatDateTime(providerMeta.latestRunAt)}` : 'never run yet'}
                </div>
                {providerMeta?.missingProviders.length ? (
                  <div>
                    <span className="fw-semibold file-detail-label">Missing:</span>{' '}
                    {providerMeta.missingProviders.join(', ')}
                  </div>
                ) : null}
                <div>
                  <span className="fw-semibold file-detail-label">Next auto-scan:</span> {nextAutoScanText}
                </div>
              </div>
            </div>
            {providerState.error ? <div className="text-danger small mb-2">{providerState.error}</div> : null}
            {favoriteState.error ? <div className="text-danger small mb-2">{favoriteState.error}</div> : null}
            {deleteState.error ? <div className="text-danger small mb-2">{deleteState.error}</div> : null}
            <div className="file-detail-topmatches mb-3">
              {matchRemoveState.error ? (
                <div className="text-danger small mb-2">{matchRemoveState.error}</div>
              ) : null}
              {providerHighlights.length ? (
                <div className="file-detail-topmatches-list">
                  {providerHighlights.map((item) => (
                    <a
                      key={item.id}
                      className="file-detail-topmatches-card text-decoration-none border border-secondary rounded p-2 bg-dark text-light"
                      href={item.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <button
                        type="button"
                        className="file-detail-topmatches-remove"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void removeTopMatch(item.sourceUrl);
                        }}
                        disabled={matchRemoveState.loading}
                        aria-label={`Remove ${item.sourceName}`}
                      >
                        ×
                      </button>
                      <div className="text-secondary small">{item.provider}</div>
                      <div className="fw-semibold text-truncate" title={item.sourceName}>
                        {item.sourceName}
                      </div>
                      <div className="text-secondary small">
                        {(() => {
                          const value = item.score;
                          const label = 'score';
                          return value !== null ? `${label} ${value}` : `${label} n/a`;
                        })()}
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="text-secondary small">
                  {!providerMeta?.hasRuns
                    ? 'No scan results yet.'
                    : displayFilterActive
                      ? 'No matches for selected sauces yet.'
                      : 'No high-confidence matches yet.'}
                </div>
              )}
            </div>
            </div>
            </div>
            {renderNeighborPreview(nextLoadedFile, 'next')}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
