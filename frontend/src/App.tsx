import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type TouchEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';

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
import type { CredentialProvider, CredentialSummary, DuplicateScanStatus, FavoriteSyncStatus, ProviderRun } from './api';
import { AuthForm } from '@/features/auth/AuthForm';
import { FileDetailPanel } from '@/features/file-detail/FileDetailPanel';
import { FileDetailPreview } from '@/features/file-detail/FileDetailPreview';
import { FoldersListPanel } from '@/features/folders/FoldersListPanel';
import { SauceFavoritesSettings } from '@/features/favorites-sauce/SauceFavoritesSettings';
import { DuplicatesView } from '@/features/duplicates/DuplicatesView';
import { GalleryView } from '@/features/library/GalleryView';
import { useCurrentUser, useLogin, useLogout, useRegister } from '@/hooks/auth';
import { useDeleteFolder, useFolders, useUploadFolderFiles } from '@/hooks/folders';
import {
  useDeleteFile,
  useRunProvider,
  useUpdateFileFavorite,
  useUpdateManualOrder
} from '@/hooks/files';
import { useUpdateSauceSettings } from '@/hooks/sauces';
import {
  useSyncFavorites,
  useUpdateFavoritesSettings
} from '@/hooks/favorites';
import { useUpdateCredential } from '@/hooks/credentials';
import {
  useAddManualTag,
  useClearFileTags,
  useRefreshFileTags,
  useRemoveManualTag,
  useRemoveTopMatch
} from '@/hooks/tags';
import {
  useCancelDuplicateScan,
  useStartDuplicateScan,
  useUpdateDuplicateSettings
} from '@/hooks/duplicates';
import { queryKeys } from '@/lib/query-keys';

type FetchState = {
  loading: boolean;
  error: string | null;
};

type FolderUploadPhase = 'uploading' | 'processing' | 'success' | 'warning' | 'error';

type FolderUploadState = {
  phase: FolderUploadPhase;
  progress: number;
  message: string;
  detail: string | null;
};

type GallerySort = 'manual' | 'mtime_desc' | 'mtime_asc' | 'random';

type GalleryCacheKeyOptions = {
  folderId?: string;
  sort: GallerySort;
  tagQuery: string;
  randomSeed: string;
  filterKey: string;
};

const gallerySortStorageKey = 'imagesearch.gallerySort';
const folderUploadResultVisibilityMs = 30_000;
const makeRandomSeed = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const buildGalleryCacheKey = ({ folderId, sort, tagQuery, randomSeed, filterKey }: GalleryCacheKeyOptions) => {
  const folderKey = folderId || 'all';
  return sort === 'random'
    ? `${folderKey}:${sort}:${tagQuery}:${randomSeed}:${filterKey}`
    : `${folderKey}:${sort}:${tagQuery}:${filterKey}`;
};

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

const normalizeComparablePath = (value: string) => {
  if (!value) return '/';
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
};

const getRelativeFolderPath = (folderPath: string, libraryRoot: string) => {
  const normalizedFolder = normalizeComparablePath(folderPath);
  const normalizedRoot = normalizeComparablePath(libraryRoot);
  if (normalizedFolder === normalizedRoot) return '';
  if (!normalizedFolder.startsWith(`${normalizedRoot}/`)) return null;
  return normalizedFolder.slice(normalizedRoot.length + 1);
};

const describeFolder = (folder: Folder, libraryRoot: string) => {
  const relativePath = getRelativeFolderPath(folder.path, libraryRoot);
  const isDirectChild = Boolean(relativePath && !relativePath.includes('/'));
  if (relativePath === '') {
    return {
      isRoot: true,
      isAutoManaged: true,
      title: 'Main library',
      subtitle: 'Default gooncave-library folder',
      pathLabel: folder.path,
      filterLabel: 'Main library'
    };
  }

  const title = basenameFromPath(relativePath || folder.path) || folder.path;
  return {
    isRoot: false,
    isAutoManaged: isDirectChild,
    title,
    subtitle: relativePath ? (isDirectChild ? null : `Mounted folder: ${relativePath}`) : 'Mounted folder',
    pathLabel: folder.path,
    filterLabel: relativePath || title
  };
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
        keepId: winner.id,
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

const folderUploadBarClass = (phase: FolderUploadPhase) => {
  switch (phase) {
    case 'uploading':
      return 'bg-info';
    case 'processing':
      return 'bg-warning text-dark progress-bar-striped progress-bar-animated';
    case 'success':
      return 'bg-success';
    case 'warning':
      return 'bg-warning text-dark';
    case 'error':
      return 'bg-danger';
    default:
      return 'bg-secondary';
  }
};

const uploadInputAccept = '.jpg,.jpeg,.png,.gif,.bmp,.webp,.tif,.tiff,.avif,.mp4,.mov,.avi,.mkv,.webm,.wmv,.flv,.m4v';

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
const authUsernameRegex = /^[a-zA-Z0-9_-]+$/;

const isCredentialReady = (provider: CredentialProvider, credential: CredentialSummary | undefined) => {
  if (!credential) return false;
  if (provider === 'SAUCENAO') return credential.hasApiKey;
  return Boolean(credential.username) && credential.hasApiKey;
};

const isGallerySort = (value: string | null): value is GallerySort =>
  value === 'manual' || value === 'mtime_desc' || value === 'mtime_asc' || value === 'random';

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

const GALLERY_PAGE_SIZE = 200;

function App() {
  const queryClient = useQueryClient();
  const currentUserQuery = useCurrentUser();
  const loginMutation = useLogin();
  const registerMutation = useRegister();
  const logoutMutation = useLogout();
  const authUser = currentUserQuery.data ?? null;
  const authMutationError =
    (loginMutation.error as Error | null)?.message ??
    (registerMutation.error as Error | null)?.message ??
    null;
  const authPending =
    currentUserQuery.isLoading ||
    loginMutation.isPending ||
    registerMutation.isPending ||
    logoutMutation.isPending;
  const [authLocalError, setAuthLocalError] = useState<string | null>(null);
  const authState: FetchState = {
    loading: authPending,
    error: authLocalError ?? authMutationError
  };
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [authForm, setAuthForm] = useState({ username: '', password: '', confirmPassword: '' });
  const foldersQuery = useFolders({ enabled: Boolean(authUser) });
  const folders = foldersQuery.data ?? [];
  const deleteFolderMutation = useDeleteFolder();
  const uploadFolderFilesMutation = useUploadFolderFiles();
  const deleteFileMutation = useDeleteFile();
  const updateFileFavoriteMutation = useUpdateFileFavorite();
  const runProviderMutation = useRunProvider();
  const updateManualOrderMutation = useUpdateManualOrder();
  const updateSauceSettingsMutation = useUpdateSauceSettings();
  const syncFavoritesMutation = useSyncFavorites();
  const updateFavoritesSettingsMutation = useUpdateFavoritesSettings();
  const updateCredentialMutation = useUpdateCredential();
  const updateDuplicateSettingsMutation = useUpdateDuplicateSettings();
  const startDuplicateScanMutation = useStartDuplicateScan();
  const cancelDuplicateScanMutation = useCancelDuplicateScan();
  const addManualTagMutation = useAddManualTag();
  const removeManualTagMutation = useRemoveManualTag();
  const refreshFileTagsMutation = useRefreshFileTags();
  const clearFileTagsMutation = useClearFileTags();
  const removeTopMatchMutation = useRemoveTopMatch();
  const [galleryFolderId, setGalleryFolderId] = useState('');
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
  const [providerInfo, setProviderInfo] = useState<ProviderRun[]>([]);
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
  // Booru-sites "developer options" toggle. Hidden by default; when on it
  // reveals the probe attempts table + manual engine override inside
  // <BooruSitesPanel>. Persisted in localStorage so power users don't
  // re-enable it every session.
  const [booruDevOptions, setBooruDevOptions] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('booru:devOptions') === '1';
  });
  const setBooruDevOptionsPersistent = (next: boolean) => {
    setBooruDevOptions(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('booru:devOptions', next ? '1' : '0');
    }
  };
  const [favoritesSyncState, setFavoritesSyncState] = useState<FetchState>({ loading: false, error: null });
  const [favoritesSyncStatus, setFavoritesSyncStatus] = useState<FavoriteSyncStatus | null>(null);
  const favoritesPollRef = useRef<number | null>(null);
  const [favoritesSettingsState, setFavoritesSettingsState] = useState<FetchState>({ loading: false, error: null });
  const [favoritesSettings, setFavoritesSettings] = useState<{
    reverseSyncEnabled: boolean;
    autoSyncMidnight: boolean;
    autoFavEnabled: boolean;
    favoritesRootId: string | null;
  }>({
    reverseSyncEnabled: false,
    autoSyncMidnight: false,
    autoFavEnabled: false,
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
    pixelThreshold: 0.005,
    sampleSize: 96,
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
  const savedGalleryScrollRef = useRef(0);
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
  const [folderActionState, setFolderActionState] = useState<FetchState>({ loading: false, error: null });
  const [folderUploads, setFolderUploads] = useState<Record<string, FolderUploadState>>({});
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
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadFolderIdRef = useRef<string | null>(null);
  const folderUploadHideTimersRef = useRef<Record<string, number>>({});

  const credentialMap = useMemo(() => {
    const map = new Map<CredentialProvider, CredentialSummary>();
    credentials.forEach((entry) => map.set(entry.provider, entry));
    return map;
  }, [credentials]);

  const folderMap = useMemo(() => {
    return new Map(folders.map((folder) => [folder.id, folder]));
  }, [folders]);

  const folderDetailsById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof describeFolder>>();
    if (!authUser) return map;
    folders.forEach((folder) => {
      map.set(folder.id, describeFolder(folder, authUser.libraryRoot));
    });
    return map;
  }, [authUser, folders]);

  const orderedFolders = useMemo(() => {
    return [...folders].sort((left, right) => {
      const leftInfo = folderDetailsById.get(left.id);
      const rightInfo = folderDetailsById.get(right.id);
      if (leftInfo?.isRoot !== rightInfo?.isRoot) {
        return leftInfo?.isRoot ? -1 : 1;
      }
      const leftLabel = leftInfo?.filterLabel ?? left.path;
      const rightLabel = rightInfo?.filterLabel ?? right.path;
      const byLabel = leftLabel.localeCompare(rightLabel);
      if (byLabel !== 0) return byLabel;
      return left.path.localeCompare(right.path);
    });
  }, [folderDetailsById, folders]);

  const selectedGalleryFolder = galleryFolderId ? folderMap.get(galleryFolderId) ?? null : null;

  const clearFolderUploadHideTimer = useCallback((folderId: string) => {
    const timer = folderUploadHideTimersRef.current[folderId];
    if (timer === undefined) return;
    window.clearTimeout(timer);
    delete folderUploadHideTimersRef.current[folderId];
  }, []);

  const scheduleFolderUploadHide = useCallback(
    (folderId: string) => {
      clearFolderUploadHideTimer(folderId);
      folderUploadHideTimersRef.current[folderId] = window.setTimeout(() => {
        setFolderUploads((prev) => {
          if (!(folderId in prev)) return prev;
          const next = { ...prev };
          delete next[folderId];
          return next;
        });
        delete folderUploadHideTimersRef.current[folderId];
      }, folderUploadResultVisibilityMs);
    },
    [clearFolderUploadHideTimer]
  );

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
      const cacheKey = buildGalleryCacheKey({
        folderId: galleryFolderId,
        sort: gallerySort,
        tagQuery: galleryTagQuery,
        randomSeed: galleryRandomSeed,
        filterKey
      });
      const cached = allowCache ? galleryCacheRef.current.get(cacheKey) : null;
      if (options.reset && cached) {
        setGalleryFiles(cached.files);
        setGalleryTotal(cached.total);
        setGalleryOffset(cached.offset);
        setGalleryHasMore(cached.hasMore);
      }
      const offset = shouldPaginate ? (options.reset ? 0 : galleryOffsetRef.current) : undefined;
      const limit = shouldPaginate ? GALLERY_PAGE_SIZE : undefined;
      setGalleryPageState({ loading: true, error: null });
      try {
        const data = await api.getFiles(galleryFolderId || undefined, gallerySort, galleryTagQuery, {
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
    [galleryFavoritesOnly, galleryFolderId, galleryMediaFilter, GALLERY_PAGE_SIZE, galleryRandomSeed, gallerySort, galleryTagQuery]
  );

  const refreshFolders = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) {
        setFetchState({ loading: true, error: null });
      }
      try {
        await foldersQuery.refetch({ throwOnError: true });
        if (!options.silent) {
          setFetchState({ loading: false, error: null });
        }
      } catch (err) {
        if (!options.silent) {
          setFetchState({ loading: false, error: (err as Error).message });
        }
      }
    },
    [foldersQuery]
  );

  const loadData = useCallback(async () => {
    await refreshFolders();
  }, [refreshFolders]);

  const loadSauces = useCallback(async () => {
    setSauceState({ loading: true, error: null });
    try {
      const data = await queryClient.fetchQuery({ queryKey: queryKeys.sauces.list(), queryFn: () => api.getSauces() });
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
      const data = await queryClient.fetchQuery({ queryKey: queryKeys.duplicates.settings(), queryFn: () => api.getDuplicateSettings() });
      setDuplicateSettings(data);
      setDuplicateSettingsState({ loading: false, error: null });
    } catch (err) {
      setDuplicateSettingsState({ loading: false, error: (err as Error).message });
    }
  }, []);

  const loadFavoritesSettings = useCallback(async () => {
    setFavoritesSettingsState({ loading: true, error: null });
    try {
      const data = await queryClient.fetchQuery({ queryKey: queryKeys.favorites.settings(), queryFn: () => api.getFavoritesSettings() });
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
      const data = await queryClient.fetchQuery({ queryKey: queryKeys.credentials.list(), queryFn: () => api.getCredentials() });
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
      const data = await queryClient.fetchQuery({ queryKey: queryKeys.favorites.syncStatus(), queryFn: () => api.getFavoritesSyncStatus() });
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
        const start = await startDuplicateScanMutation.mutateAsync(override ?? duplicateOptions);
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
    const handleAuthRequired = () => {
      Object.values(folderUploadHideTimersRef.current).forEach((timer) => window.clearTimeout(timer));
      folderUploadHideTimersRef.current = {};
      if (favoritesPollRef.current !== null) {
        window.clearInterval(favoritesPollRef.current);
        favoritesPollRef.current = null;
      }
      galleryCacheRef.current.clear();
      setSelectedFile(null);
      setGalleryFiles([]);
      setGalleryTotal(0);
      setGalleryOffset(0);
      setGalleryHasMore(false);
      setCredentials([]);
      setFavoritesSyncStatus(null);
      setDuplicateGroups([]);
      setDuplicateStats(null);
      setDuplicateScanStatus(null);
      setAuthLocalError(null);
      queryClient.setQueryData(queryKeys.auth.me(), null);
      queryClient.removeQueries({ queryKey: queryKeys.folders.all });
      queryClient.removeQueries({ queryKey: queryKeys.files.all });
      queryClient.removeQueries({ queryKey: queryKeys.sauces.all });
      queryClient.removeQueries({ queryKey: queryKeys.favorites.all });
      queryClient.removeQueries({ queryKey: queryKeys.credentials.all });
      queryClient.removeQueries({ queryKey: queryKeys.duplicates.all });
      queryClient.removeQueries({ queryKey: queryKeys.booruSites.all });
    };
    window.addEventListener(authRequiredEvent, handleAuthRequired);
    return () => {
      window.removeEventListener(authRequiredEvent, handleAuthRequired);
    };
  }, [queryClient]);

  // useFolders is enabled by `authUser` truthy, so the folders fetch
  // already fires on login — no manual loadData call needed here. The
  // remaining loadData reference (manualOrder failure recovery) stays so
  // a failed reorder can still pull a fresh list.

  useEffect(() => {
    return () => {
      Object.values(folderUploadHideTimersRef.current).forEach((timer) => window.clearTimeout(timer));
      folderUploadHideTimersRef.current = {};
    };
  }, []);

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
    if (galleryFolderId && !folderMap.has(galleryFolderId)) {
      setGalleryFolderId('');
    }
  }, [folderMap, galleryFolderId]);

  useEffect(() => {
    if (!authUser) return;
    if (viewMode !== 'gallery') return;
    const isRandom = gallerySort === 'random';
    const filterKey = `${galleryMediaFilter}:${galleryFavoritesOnly ? 'fav' : 'all'}`;
    const cacheKey = buildGalleryCacheKey({
      folderId: galleryFolderId,
      sort: gallerySort,
      tagQuery: galleryTagQuery,
      randomSeed: galleryRandomSeed,
      filterKey
    });
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
  }, [authUser, viewMode, galleryFavoritesOnly, galleryFolderId, galleryMediaFilter, galleryRandomSeed, gallerySort, galleryTagQuery, loadGalleryPage]);

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
      setAuthLocalError('Username and password are required');
      return;
    }
    if (username.length < 3) {
      setAuthLocalError('Username must be at least 3 characters');
      return;
    }
    if (username.length > 32) {
      setAuthLocalError('Username must be at most 32 characters');
      return;
    }
    if (!authUsernameRegex.test(username)) {
      setAuthLocalError('Username can only contain letters, numbers, _ and -');
      return;
    }
    if (password.length < 8) {
      setAuthLocalError('Password must be at least 8 characters');
      return;
    }
    if (authMode === 'register' && password !== authForm.confirmPassword) {
      setAuthLocalError('Passwords do not match');
      return;
    }
    setAuthLocalError(null);
    try {
      if (authMode === 'register') {
        await registerMutation.mutateAsync({ username, password });
      } else {
        await loginMutation.mutateAsync({ username, password });
      }
      galleryCacheRef.current.clear();
      setAuthForm({ username: '', password: '', confirmPassword: '' });
    } catch {
      // Mutation error surfaces via authMutationError; nothing extra to do here.
    }
  };

  const logout = async () => {
    setAuthLocalError(null);
    try {
      await logoutMutation.mutateAsync();
    } catch (err) {
      // Server-side session may already be gone (network drop, already-
      // expired cookie). Tear down local state regardless; the user is
      // logged out from their perspective. Surface the error so a real
      // failure isn't silently swallowed.
      // eslint-disable-next-line no-console
      console.warn('logout request failed; clearing local state anyway', err);
    } finally {
      if (favoritesPollRef.current !== null) {
        window.clearInterval(favoritesPollRef.current);
        favoritesPollRef.current = null;
      }
      galleryCacheRef.current.clear();
      setSelectedFile(null);
      setGalleryFiles([]);
      setGalleryTotal(0);
      setGalleryOffset(0);
      setGalleryHasMore(false);
      setCredentials([]);
      setGalleryFolderId('');
      setFolderUploads({});
      setFavoritesSyncStatus(null);
      setDuplicateGroups([]);
      setDuplicateStats(null);
      setDuplicateScanStatus(null);
    }
  };
  const openFolderUploadPicker = (folderId: string) => {
    const uploadState = folderUploads[folderId];
    if (folderActionState.loading || uploadState?.phase === 'uploading' || uploadState?.phase === 'processing') return;
    pendingUploadFolderIdRef.current = folderId;
    const input = uploadInputRef.current;
    if (!input) return;
    input.value = '';
    input.click();
  };

  const uploadFilesToFolder = useCallback(
    async (folder: Folder, files: File[]) => {
      if (!files.length) return;
      const uploadMessage = files.length === 1 ? `Uploading ${files[0].name}` : `Uploading ${files.length} files`;
      clearFolderUploadHideTimer(folder.id);
      setFolderUploads((prev) => ({
        ...prev,
        [folder.id]: {
          phase: 'uploading',
          progress: 0,
          message: uploadMessage,
          detail: null
        }
      }));

      try {
        const result = await uploadFolderFilesMutation.mutateAsync({
          folderId: folder.id,
          files,
          onProgress: ({ percent }) => {
            setFolderUploads((prev) => ({
              ...prev,
              [folder.id]: {
                phase: 'uploading',
                progress: percent,
                message: uploadMessage,
                detail: null
              }
            }));
          }
        });

        setFolderUploads((prev) => ({
          ...prev,
          [folder.id]: {
            phase: 'processing',
            progress: 100,
            message: 'Processing uploaded files…',
            detail: null
          }
        }));

        galleryCacheRef.current.clear();
        await refreshFolders({ silent: true });
        if (viewMode === 'gallery') {
          await loadGalleryPage({ reset: true });
        }

        const uploadedCount = result.uploaded.length;
        const rejectedCount = result.rejected.length;
        const rejectedDetail = rejectedCount
          ? result.rejected.map((entry) => `${entry.name}: ${entry.reason ?? 'Skipped'}`).join(' | ')
          : null;

        let phase: FolderUploadPhase = 'success';
        let message = `Uploaded ${uploadedCount} file${uploadedCount === 1 ? '' : 's'}.`;
        if (uploadedCount === 0 && rejectedCount > 0) {
          phase = 'error';
          message = `No files uploaded. ${rejectedCount} rejected.`;
        } else if (uploadedCount > 0 && rejectedCount > 0) {
          phase = 'warning';
          message = `Uploaded ${uploadedCount} file${uploadedCount === 1 ? '' : 's'}. ${rejectedCount} rejected.`;
        }

        setFolderUploads((prev) => ({
          ...prev,
          [folder.id]: {
            phase,
            progress: 100,
            message,
            detail: rejectedDetail
          }
        }));
        scheduleFolderUploadHide(folder.id);
      } catch (err) {
        setFolderUploads((prev) => ({
          ...prev,
          [folder.id]: {
            phase: 'error',
            progress: 0,
            message: 'Upload failed.',
            detail: (err as Error).message
          }
        }));
        scheduleFolderUploadHide(folder.id);
      }
    },
    [clearFolderUploadHideTimer, loadGalleryPage, refreshFolders, scheduleFolderUploadHide, viewMode]
  );

  const onFolderUploadInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const folderId = pendingUploadFolderIdRef.current;
    pendingUploadFolderIdRef.current = null;
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!folderId || files.length === 0) return;
    const folder = folderMap.get(folderId);
    if (!folder) return;
    await uploadFilesToFolder(folder, files);
  };

  const onDeleteFolder = async (folder: Folder) => {
    if (!window.confirm(`Remove "${folder.path}" from the watch list?`)) return;
    setFolderActionState({ loading: true, error: null });
    try {
      await deleteFolderMutation.mutateAsync(folder.id);
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
      await deleteFileMutation.mutateAsync(fileId);
      setGalleryFiles((prev) => prev.filter((file) => file.id !== fileId));
      setGalleryTotal((prev) => (prev > 0 ? prev - 1 : 0));
      setGalleryOffset((prev) => Math.max(0, prev - 1));
      const filterKey = `${galleryMediaFilter}:${galleryFavoritesOnly ? 'fav' : 'all'}`;
      const cacheKey = buildGalleryCacheKey({
        folderId: galleryFolderId,
        sort: gallerySort,
        tagQuery: galleryTagQuery,
        randomSeed: galleryRandomSeed,
        filterKey
      });
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
      const cacheKey = buildGalleryCacheKey({
        folderId: galleryFolderId,
        sort: gallerySort,
        tagQuery: galleryTagQuery,
        randomSeed: galleryRandomSeed,
        filterKey
      });
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
    [galleryFavoritesOnly, galleryFolderId, galleryMediaFilter, galleryRandomSeed, gallerySort, galleryTagQuery]
  );

  const onToggleFavorite = async () => {
    if (!selectedFile) return;
    const nextFavorite = !selectedFile.isFavorite;
    setFavoriteState({ loading: true, error: null });
    try {
      const resp = await updateFileFavoriteMutation.mutateAsync({ fileId: selectedFile.id, favorite: nextFavorite });
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
        await updateManualOrderMutation.mutateAsync(next.map((file) => file.id));
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
      const resp = await queryClient.fetchQuery({ queryKey: queryKeys.files.providers(fileId), queryFn: () => api.getProviders(fileId) });
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
      const data = await queryClient.fetchQuery({ queryKey: queryKeys.favorites.syncStatus(), queryFn: () => api.getFavoritesSyncStatus() });
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
      const data = await syncFavoritesMutation.mutateAsync({ deleteMissing });
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
    autoFavEnabled?: boolean;
    favoritesRootId?: string | null;
  }) => {
    setFavoritesSettingsState({ loading: true, error: null });
    try {
      const data = await updateFavoritesSettingsMutation.mutateAsync(updates);
      setFavoritesSettings(data);
      setFavoritesSettingsState({ loading: false, error: null });
    } catch (err) {
      setFavoritesSettingsState({ loading: false, error: (err as Error).message });
    }
  };

  const updateDuplicateSettings = async (updates: Partial<DuplicateSettings>) => {
    setDuplicateSettingsState({ loading: true, error: null });
    try {
      const data = await updateDuplicateSettingsMutation.mutateAsync(updates);
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
      const updated = await updateCredentialMutation.mutateAsync(payload);
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
      const updated = await updateCredentialMutation.mutateAsync({ provider, username: '', apiKey: '' });
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
      const resp = await queryClient.fetchQuery({ queryKey: queryKeys.files.tags(fileId), queryFn: () => api.getFileTags(fileId) });
      if (resp.tags.length === 0 && !tagRefreshRef.current.has(fileId)) {
        tagRefreshRef.current.add(fileId);
        const refreshed = await refreshFileTagsMutation.mutateAsync(fileId);
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
      const refreshed = await refreshFileTagsMutation.mutateAsync(selectedFile.id);
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
      await clearFileTagsMutation.mutateAsync(selectedFile.id);
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
      await deleteFileMutation.mutateAsync(discard.id);
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

  const addManualTag = async () => {
    if (!selectedFile) return;
    const value = manualTagInput.trim();
    if (!value) return;
    try {
      setTagState({ loading: true, error: null });
      await addManualTagMutation.mutateAsync({ fileId: selectedFile.id, tag: value, category: manualTagCategory });
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
      await removeManualTagMutation.mutateAsync({ fileId: selectedFile.id, tag: tag, category: category });
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
      const resp = await removeTopMatchMutation.mutateAsync({ fileId: selectedFile.id, sourceUrl: sourceUrl });
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
      const runMs = new Date(run.completedAt || run.createdAt).getTime();
      if (!Number.isNaN(runMs) && runMs > latestRunMs) {
        latestRunMs = runMs;
      }
      if (!Number.isNaN(runMs) && runMs < firstRunMs) {
        firstRunMs = runMs;
      }
      const existing = latestByProvider.get(run.provider);
      const existingMs = existing ? new Date(existing.completedAt || existing.createdAt).getTime() : 0;
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
      const width = detailSwipeFrameRef.current?.clientWidth || window.innerWidth || 1;
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
    const width = detailSwipeFrameRef.current?.clientWidth || window.innerWidth || 1;
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
    savedGalleryScrollRef.current = window.scrollY;
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
      const res = await updateSauceSettingsMutation.mutateAsync(nextSettings);
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
    // Intentional global mutation: App is the SPA root, lives for the entire
    // session, no unmount restore needed. Manual mode prevents the browser's
    // smooth-scroll-back animation that fights our instant restore below.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  }, []);

  useEffect(() => {
    if (selectedFile) {
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    } else {
      window.scrollTo({ top: savedGalleryScrollRef.current, behavior: 'instant' as ScrollBehavior });
    }
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


  if (authState.loading && !authUser) {
    return (
      <div className="bg-background text-foreground min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground">Checking session…</div>
      </div>
    );
  }

  if (!authUser) {
    return (
      <AuthForm
        mode={authMode}
        values={authForm}
        loading={authState.loading}
        error={authState.error}
        onModeChange={(next) => {
          setAuthMode(next);
          setAuthLocalError(null);
        }}
        onChange={setAuthForm}
        onSubmit={() => void submitAuth()}
      />
    );
  }

  return (
    <div className="bg-background text-foreground min-h-screen">
      {selectedFile ? null : (
      <div className="container page-shell">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h1 className="h3 mb-1">GoonCave</h1>
            <div className="text-muted-foreground text-sm">Signed in as {authUser.username}</div>
          </div>
          <div>
            <button className="btn btn-outline-light btn-sm" type="button" onClick={() => void logout()}>
              Logout
            </button>
          </div>
        </div>
        <div className="btn-group mb-6" role="group" aria-label="view switcher">
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

        {fetchState.error ? <div className="text-destructive mb-4">Error: {fetchState.error}</div> : null}
        {manualOrderState.error ? <div className="text-destructive mb-4">Manual order: {manualOrderState.error}</div> : null}
        {manualOrderState.loading ? <div className="text-muted-foreground text-sm mb-4">Saving manual order…</div> : null}
        <div className={`row ${viewMode === 'folders' ? 'g-0 settings-sections' : 'g-4'}`}>
          {viewMode === 'folders' ? (
            <>
              <FoldersListPanel
                orderedFolders={orderedFolders}
                folderDetailsById={folderDetailsById}
                folderUploads={folderUploads}
                folderActionState={folderActionState}
                favoritesSettings={favoritesSettings}
                favoritesSettingsState={favoritesSettingsState}
                libraryRoot={authUser.libraryRoot}
                uploadInputAccept={uploadInputAccept}
                uploadInputRef={uploadInputRef}
                onFolderUploadInputChange={onFolderUploadInputChange}
                onOpenFolderUploadPicker={openFolderUploadPicker}
                onUpdateFavoritesRoot={(folderId) => void updateFavoritesSettings({ favoritesRootId: folderId })}
                onDeleteFolder={onDeleteFolder}
                describeFolder={describeFolder}
              />
              <SauceFavoritesSettings
                sauceSources={sauceSources}
                sauceSettings={sauceSettings}
                sauceProgress={sauceProgress}
                sauceState={sauceState}
                sauceProgressSegments={sauceProgressSegments}
                displaySet={displaySet}
                targetSet={targetSet}
                favoritesSyncState={favoritesSyncState}
                favoritesSyncStatus={favoritesSyncStatus}
                favoritesSettings={favoritesSettings}
                favoritesSettingsState={favoritesSettingsState}
                favoritesProgress={favoritesProgress}
                favoritesSummary={favoritesSummary}
                favoritesErrors={favoritesErrors}
                e621Ready={e621Ready}
                danbooruReady={danbooruReady}
                saucenaoReady={saucenaoReady}
                credentialsState={credentialsState}
                credentialLastProvider={credentialLastProvider}
                credentialInputs={credentialInputs}
                credentialExpanded={credentialExpanded}
                booruDevOptions={booruDevOptions}
                toggleDisplaySauce={toggleDisplaySauce}
                toggleTargetSauce={toggleTargetSauce}
                setAllDisplay={setAllDisplay}
                setAllTargets={setAllTargets}
                runFavoritesSync={runFavoritesSync}
                updateFavoritesSettings={updateFavoritesSettings}
                logoutCredential={logoutCredential}
                saveCredential={saveCredential}
                updateCredentialInput={updateCredentialInput}
                setCredentialExpanded={setCredentialExpanded}
                setBooruDevOptionsPersistent={setBooruDevOptionsPersistent}
                canonicalizeSauceKey={canonicalizeSauceKey}
              />
            </>
          ) : viewMode === 'duplicates' ? (
            <DuplicatesView
              duplicateSettings={duplicateSettings}
              duplicateSettingsState={duplicateSettingsState}
              updateDuplicateSettings={updateDuplicateSettings}
              duplicateOptions={duplicateOptions}
              setDuplicateOptions={setDuplicateOptions}
              duplicateState={duplicateState}
              duplicateScanStatus={duplicateScanStatus}
              loadDuplicates={() => void loadDuplicates()}
              duplicatePairs={duplicatePairs}
              duplicateStats={duplicateStats}
              duplicateAction={duplicateAction}
              resolveDuplicateChoice={(keep, discard) => void resolveDuplicateChoice(keep, discard)}
              resolveDuplicateKeepBoth={resolveDuplicateKeepBoth}
            />
          ) : (
            <GalleryView
              galleryFolderId={galleryFolderId}
              galleryFiles={galleryFiles}
              galleryTotal={galleryTotal}
              galleryHasMore={galleryHasMore}
              galleryPageState={galleryPageState}
              gallerySort={gallerySort}
              galleryFilters={galleryFilters}
              isGalleryFilterOpen={isGalleryFilterOpen}
              galleryTagInput={galleryTagInput}
              galleryFilterLabel={galleryFilterLabel}
              galleryCountText={galleryCountText}
              selectedGalleryFolder={selectedGalleryFolder}
              orderedFolders={orderedFolders}
              folderDetailsById={folderDetailsById}
              manualOrderState={manualOrderState}
              draggingId={draggingId}
              dragOverId={dragOverId}
              galleryFilterRef={galleryFilterRef}
              galleryLoadMoreRef={galleryLoadMoreRef}
              dragActiveRef={dragActiveRef}
              onFolderChange={(folderId) => setGalleryFolderId(folderId)}
              onTagInputChange={(value) => setGalleryTagInput(value)}
              onTagQueryClear={() => setGalleryTagQuery('')}
              onFilterChange={(patch) => setGalleryFilters((prev) => ({ ...prev, ...patch }))}
              onFilterOpenToggle={() => setIsGalleryFilterOpen((prev) => !prev)}
              onSortChange={(sort) => applyGallerySort(sort)}
              onFileOpen={openFile}
              onLoadMore={() => void loadGalleryPage()}
              onMoveManualItem={moveManualItem}
              onDraggingChange={(id) => setDraggingId(id)}
              onDragOverChange={(id) => setDragOverId(id)}
            />
          )}

        </div>
      </div>
      )}
      {selectedFile ? (
        <FileDetailPanel
          selectedFile={selectedFile}
          selectedFileName={selectedFileName}
          selectedFileType={selectedFileType}
          selectedFileFavorite={selectedFileFavorite}
          mediaFullscreen={mediaFullscreen}
          onToggleFullscreen={() => setMediaFullscreen((prev) => !prev)}
          hasPrev={hasPrev}
          hasNext={hasNext}
          navPeek={navPeek}
          prevLoadedFile={prevLoadedFile}
          nextLoadedFile={nextLoadedFile}
          detailSwipeFrameRef={detailSwipeFrameRef}
          detailSwipeOffset={detailSwipeOffset}
          detailSwipeTransition={detailSwipeTransition}
          onDetailTouchStart={onDetailTouchStart}
          onDetailTouchMove={onDetailTouchMove}
          onDetailTouchEnd={onDetailTouchEnd}
          shareState={shareState}
          favoriteState={favoriteState}
          deleteState={deleteState}
          tagState={tagState}
          providerState={providerState}
          matchRemoveState={matchRemoveState}
          tagGroups={tagGroups}
          tagSourceSummary={tagSourceSummary}
          manualTagInput={manualTagInput}
          manualTagCategory={manualTagCategory}
          onManualTagInputChange={(value) => setManualTagInput(value)}
          onManualTagCategoryChange={(value) => setManualTagCategory(value)}
          onAddManualTag={() => void addManualTag()}
          onRemoveManualTag={(tag, category) => void removeManualTag(tag, category)}
          onRefreshTags={() => void refreshTags()}
          providerHighlights={providerHighlights}
          providerMeta={providerMeta}
          nextAutoScanText={nextAutoScanText}
          displayFilterActive={displayFilterActive}
          onRunAllProviders={() => void onRunAllProviders()}
          onRemoveTopMatch={(sourceUrl) => void removeTopMatch(sourceUrl)}
          onDownloadFile={() => void onDownloadFile()}
          onToggleFavorite={() => void onToggleFavorite()}
          onDeleteFile={(id) => void onDeleteFile(id)}
          onClose={closeFile}
          onGoRelative={(delta) => void goRelative(delta)}
          renderNeighborPreview={(file, direction) => (
            <FileDetailPreview file={file} direction={direction} />
          )}
          renderFileMedia={renderFileMedia}
          formatDateTime={formatDateTime}
        />
      ) : null}
    </div>
  );
}

export default App;
