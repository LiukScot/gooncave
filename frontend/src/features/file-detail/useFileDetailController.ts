import { useQueryClient } from '@tanstack/react-query';
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent
} from 'react';
import { toast } from 'sonner';

import type {
  FetchState,
  Props as FileDetailPanelProps,
  ProviderHighlight,
  ProviderMeta,
  TagGroup
} from './FileDetailPanel';
import { nextSavedGalleryScroll } from './galleryScroll';
import { resolveSourceLabel, resolveTopMatchSourceName } from './sourceLabels';

import {
  api,
  API_BASE,
  type FileItem,
  type FileTag,
  type ProviderRun,
  type SauceSettings
} from '@/api';
import { useBooruSites } from '@/hooks/booru-sites';
import { useDeleteFile, useUpdateFileFavorite } from '@/hooks/files';
import {
  useAddManualTag,
  useRefreshFileTags,
  useRemoveManualTag,
  useRemoveTopMatch
} from '@/hooks/tags';
import { basenameFromPath, fileTypeFromPath } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';

// ---------------------------------------------------------------------------
// Local constants (mirrored from App.tsx — keep in sync)
// ---------------------------------------------------------------------------

type ProviderKind = 'SAUCENAO' | 'FLUFFLE';
const providerKinds: readonly ProviderKind[] = ['SAUCENAO', 'FLUFFLE'];
const providerScoreThresholds: Record<ProviderKind, number> = {
  SAUCENAO: 90,
  FLUFFLE: 95
};

type DetailSwipeAxis = 'idle' | 'x' | 'y';

const resolveProviderScore = (
  provider: ProviderKind,
  result: { score?: number | null; distance?: number | null }
): number | null => {
  if (provider !== 'FLUFFLE') {
    return typeof result.score === 'number' ? result.score : null;
  }
  if (typeof result.score === 'number') return result.score;
  if (typeof result.distance === 'number') return result.distance;
  return null;
};

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

const normalizeSauceKey = (value: string) => value.trim().toLowerCase();

const canonicalizeSauceKey = (value: string): string => {
  const key = normalizeSauceKey(value);
  if (canonicalSauces[key]) return canonicalSauces[key];
  if (key.endsWith('.e621.net')) return 'e621';
  return key;
};

const normalizeSourceName = (value: string): string => {
  let cleaned = value.trim();
  if (!cleaned) return '';
  cleaned = cleaned.replace(/^index\s*#?\d+:\s*/i, '');
  cleaned = cleaned.replace(/\s+–\s+/g, ' - ');
  if (cleaned.includes(' - ')) {
    cleaned = cleaned.split(' - ')[0].trim();
  }
  return cleaned;
};

const looksLikeFilename = (value: string): boolean => {
  if (!value) return false;
  const lower = value.toLowerCase();
  if (lower.includes('/') || lower.includes('\\')) return true;
  return /\.[a-z0-9]{2,5}$/.test(lower);
};

const sauceKeyFromResult = (
  sourceUrl: string | null | undefined,
  sourceName: string | null | undefined
): string | null => {
  if (sourceName) {
    const cleaned = normalizeSourceName(sourceName);
    if (cleaned && !looksLikeFilename(cleaned)) {
      return canonicalizeSauceKey(cleaned);
    }
  }
  if (sourceUrl) {
    try {
      return canonicalizeSauceKey(
        new URL(sourceUrl).hostname.replace(/^www\./, '')
      );
    } catch {
      return canonicalizeSauceKey(sourceUrl);
    }
  }
  return null;
};

const guessMimeType = (
  filename: string,
  mediaType: FileItem['mediaType']
): string => {
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

const triggerDownload = (url: string, filename: string): void => {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
};

const formatRemaining = (ms: number): string => {
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FileDetailGalleryDep = {
  files: FileItem[];
  currentIndex: number;
  goRelative: (delta: number) => void;
  sortIsManual: boolean;
};

export type FileDetailControllerInput = {
  gallery: FileDetailGalleryDep;
  sauceSettings: SauceSettings;
  historyMode?: 'browser' | 'external';
  onExternalClose?: () => void;
};

export type FileDetailControllerOutput = {
  selectedFile: FileItem | null;
  openFile: (file: FileItem) => void;
  closeFile: (options?: { syncUrl?: boolean }) => void;
  panelProps: FileDetailPanelProps;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFileDetailController(
  input: FileDetailControllerInput
): FileDetailControllerOutput {
  const {
    gallery,
    sauceSettings,
    historyMode = 'browser',
    onExternalClose
  } = input;
  const queryClient = useQueryClient();

  // --- mutations -----------------------------------------------------------
  const deleteFileMutation = useDeleteFile();
  const updateFileFavoriteMutation = useUpdateFileFavorite();
  const addManualTagMutation = useAddManualTag();
  const removeManualTagMutation = useRemoveManualTag();
  const refreshFileTagsMutation = useRefreshFileTags();
  const removeTopMatchMutation = useRemoveTopMatch();
  const refreshFileTags = refreshFileTagsMutation.mutateAsync;
  const booruSitesQuery = useBooruSites();

  // --- core state ----------------------------------------------------------
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);

  // --- action states -------------------------------------------------------
  const [shareState, setShareState] = useState<FetchState>({
    loading: false,
    error: null
  });
  const [favoriteState, setFavoriteState] = useState<FetchState>({
    loading: false,
    error: null
  });
  const [deleteState, setDeleteState] = useState<FetchState>({
    loading: false,
    error: null
  });
  const [tagState, setTagState] = useState<FetchState>({
    loading: false,
    error: null
  });
  const [providerState, setProviderState] = useState<FetchState>({
    loading: false,
    error: null
  });
  const [matchRemoveState, setMatchRemoveState] = useState<FetchState>({
    loading: false,
    error: null
  });

  // --- provider & tags data ------------------------------------------------
  const [providerInfo, setProviderInfo] = useState<ProviderRun[]>([]);
  const [fileTags, setFileTags] = useState<FileTag[]>([]);

  // --- tag editor ----------------------------------------------------------
  const [manualTagInput, setManualTagInput] = useState('');
  const [manualTagCategory, setManualTagCategory] = useState('general');

  // --- media ---------------------------------------------------------------
  const [mediaFullscreen, setMediaFullscreen] = useState(false);

  // --- swipe ---------------------------------------------------------------
  const [detailSwipeOffset, setDetailSwipeOffset] = useState(0);
  const [detailSwipeTransition, setDetailSwipeTransition] = useState(false);
  const [detailSwipeLocked, setDetailSwipeLocked] = useState(false);
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

  // --- nav peek ------------------------------------------------------------
  const [navPeek, setNavPeek] = useState(false);

  // --- history refs --------------------------------------------------------
  const historyActiveRef = useRef(false);
  const savedGalleryScrollRef = useRef(0);

  // --- tag refresh dedup ---------------------------------------------------
  const tagRefreshRef = useRef(new Set<string>());

  // ---------------------------------------------------------------------------
  // Derived navigation values (from gallery dep)
  // ---------------------------------------------------------------------------

  const activeIndex = gallery.currentIndex;
  const hasPrev = activeIndex > 0;
  // Note: galleryHasMore not available here — conservative false; App must wire
  // goRelative that handles load-more internally.
  const hasNext = activeIndex >= 0 && activeIndex < gallery.files.length - 1;
  const prevLoadedFile =
    activeIndex > 0 ? (gallery.files[activeIndex - 1] ?? null) : null;
  const nextLoadedFile =
    activeIndex >= 0 && activeIndex < gallery.files.length - 1
      ? (gallery.files[activeIndex + 1] ?? null)
      : null;

  // ---------------------------------------------------------------------------
  // Derived file values
  // ---------------------------------------------------------------------------

  const selectedFileName = selectedFile
    ? basenameFromPath(selectedFile.path) || selectedFile.path
    : '';
  const selectedFileType = selectedFile
    ? fileTypeFromPath(selectedFile.path, selectedFile.mediaType)
    : '';
  const selectedFileFavorite = selectedFile?.isFavorite ?? false;

  // ---------------------------------------------------------------------------
  // Sauce settings derived sets
  // ---------------------------------------------------------------------------

  const displayFilterActive =
    (sauceSettings.displayInitialized ?? false) ||
    sauceSettings.display.length > 0;

  const displaySet = useMemo(() => {
    if (!displayFilterActive) return new Set<string>();
    return new Set(sauceSettings.display.map(canonicalizeSauceKey));
  }, [displayFilterActive, sauceSettings.display]);

  const targetSet = useMemo(
    () => new Set(sauceSettings.targets.map(canonicalizeSauceKey)),
    [sauceSettings.targets]
  );
  // Keyed by raw site.id: top-match lookups feed lowercased keys from
  // sauceKeyFromResult, so this relies on booru site ids being lowercase
  // UUIDs. If that ever breaks the label degrades to the UUID (pre-fix state).
  const booruSiteNameById = useMemo(
    () =>
      Object.fromEntries(
        (booruSitesQuery.data ?? []).map((site) => [site.id, site.name])
      ),
    [booruSitesQuery.data]
  );

  // ---------------------------------------------------------------------------
  // Tag groups (derived from fileTags)
  // ---------------------------------------------------------------------------

  const tagGroups = useMemo<readonly TagGroup[]>(() => {
    const map = new Map<
      string,
      {
        tag: string;
        category: string;
        sources: Set<string>;
        score: number | null;
        hasManual: boolean;
      }
    >();
    for (const tag of fileTags) {
      const key = `${tag.category}:${tag.tag}`;
      const existing = map.get(key);
      const score = typeof tag.score === 'number' ? tag.score : null;
      if (existing) {
        existing.sources.add(tag.source);
        if (
          score !== null &&
          (existing.score === null || score > existing.score)
        ) {
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
    const grouped = Array.from(map.values()).sort((a, b) =>
      a.tag.localeCompare(b.tag)
    );
    const order = [
      'artist',
      'character',
      'copyright',
      'species',
      'general',
      'meta',
      'lore',
      'invalid',
      'other'
    ];
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

  const tagSourceSummary = useMemo(() => {
    if (fileTags.length === 0) return 'none';
    const sources = Array.from(
      new Set(
        fileTags.map((tag) =>
          resolveSourceLabel(tag.source, booruSiteNameById).toLowerCase()
        )
      )
    );
    return sources.join(', ');
  }, [booruSiteNameById, fileTags]);

  // ---------------------------------------------------------------------------
  // Provider highlights (derived from providerInfo + sauce settings)
  // ---------------------------------------------------------------------------

  const providerHighlights = useMemo<readonly ProviderHighlight[]>(() => {
    const latestByProvider = new Map<string, ProviderRun>();
    providerInfo.forEach((run) => {
      if (!latestByProvider.has(run.provider)) {
        latestByProvider.set(run.provider, run);
      }
    });

    const highlights: ProviderHighlight[] = [];

    for (const [provider, run] of latestByProvider.entries()) {
      const threshold = providerScoreThresholds[provider as ProviderKind] ?? 0;
      const results: Array<{
        sourceUrl?: string | null;
        sourceName?: string | null;
        score?: number | null;
        distance?: number | null;
      }> =
        Array.isArray(run.results) && run.results.length > 0
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
          const key = sauceKeyFromResult(
            result.sourceUrl,
            result.sourceName ?? null
          );
          if (!key || !displaySet.has(key)) continue;
        }
        const score = resolveProviderScore(provider as ProviderKind, result);
        if (score === null || score < threshold) continue;
        const distance =
          typeof result.distance === 'number'
            ? result.distance
            : Math.max(0, Math.round(100 - score));
        const sourceKey = sauceKeyFromResult(
          result.sourceUrl,
          result.sourceName ?? null
        );
        highlights.push({
          id: `${run.id}-${result.sourceUrl}`,
          provider,
          sourceUrl: result.sourceUrl,
          sourceName: resolveTopMatchSourceName(
            {
              sourceKey,
              sourceName: result.sourceName,
              provider
            },
            booruSiteNameById
          ),
          score,
          distance
        });
      }
    }

    return highlights;
  }, [providerInfo, displayFilterActive, displaySet, booruSiteNameById]);

  // ---------------------------------------------------------------------------
  // Provider meta (derived from providerInfo + targetSet)
  // ---------------------------------------------------------------------------

  const providerMeta = useMemo<ProviderMeta | null>(() => {
    if (!selectedFile) return null;

    const latestByProvider = new Map<ProviderKind, ProviderRun>();
    let latestRunMs = 0;
    let firstRunMs = Number.POSITIVE_INFINITY;
    let activeRun = false;
    let targetHit = false;

    providerInfo.forEach((run) => {
      if (run.status === 'RUNNING' || run.status === 'PENDING') {
        activeRun = true;
      }
      const runMs = new Date(run.completedAt || run.createdAt).getTime();
      if (!Number.isNaN(runMs) && runMs > latestRunMs) latestRunMs = runMs;
      if (!Number.isNaN(runMs) && runMs < firstRunMs) firstRunMs = runMs;
      const existing = latestByProvider.get(run.provider as ProviderKind);
      const existingMs = existing
        ? new Date(existing.completedAt || existing.createdAt).getTime()
        : 0;
      if (!existing || runMs > existingMs) {
        latestByProvider.set(run.provider as ProviderKind, run);
      }
    });

    if (targetSet.size > 0) {
      for (const run of providerInfo) {
        if (run.status === 'PENDING' || run.status === 'RUNNING') continue;
        const threshold =
          providerScoreThresholds[run.provider as ProviderKind] ?? 0;
        const results: Array<{
          sourceUrl?: string | null;
          sourceName?: string | null;
          score?: number | null;
        }> =
          Array.isArray(run.results) && run.results.length > 0
            ? run.results
            : [
                {
                  sourceUrl: run.sourceUrl ?? null,
                  sourceName: null,
                  score: run.score ?? null
                }
              ];
        for (const result of results) {
          const score = resolveProviderScore(
            run.provider as ProviderKind,
            result
          );
          if (score === null || score < threshold) continue;
          const key = sauceKeyFromResult(
            result.sourceUrl,
            result.sourceName ?? null
          );
          if (key && targetSet.has(key)) {
            targetHit = true;
            break;
          }
        }
        if (targetHit) break;
      }
    }

    const missingProviders = targetHit
      ? []
      : providerKinds.filter((p) => !latestByProvider.has(p));
    let nextAutoScanAt: number | null = null;
    const dayMs = 24 * 60 * 60 * 1000;

    for (const [, run] of latestByProvider.entries()) {
      const runMs = new Date(run.completedAt ?? run.createdAt).getTime();
      if (Number.isNaN(runMs)) continue;
      const nextAt = runMs + dayMs;
      if (nextAutoScanAt === null || nextAt < nextAutoScanAt)
        nextAutoScanAt = nextAt;
    }

    return {
      hasRuns: providerInfo.length > 0,
      missingProviders,
      latestRunAt: latestRunMs ? new Date(latestRunMs).toISOString() : null,
      nextAutoScanAt,
      activeRun,
      targetHit,
      expired: Number.isFinite(firstRunMs)
        ? Date.now() - firstRunMs > 7 * dayMs
        : false
    };
  }, [providerInfo, selectedFile, targetSet]);

  const nextAutoScanText = useMemo<string>(() => {
    if (!providerMeta) return '—';
    if (providerMeta.activeRun) return 'running now';
    if (providerMeta.targetHit) return 'stopped (target found)';
    if (providerMeta.missingProviders.length > 0)
      return 'pending (missing providers rotate every 10 min)';
    if (!providerMeta.hasRuns)
      return 'pending (missing providers rotate every 10 min)';
    if (providerMeta.expired) return 'stopped (7-day window elapsed)';
    if (providerMeta.nextAutoScanAt === null) return 'due now';
    return formatRemaining(providerMeta.nextAutoScanAt - Date.now());
  }, [providerMeta]);

  // ---------------------------------------------------------------------------
  // Data loaders
  // ---------------------------------------------------------------------------

  const loadProviders = useCallback(
    async (fileId: string) => {
      try {
        const resp = await queryClient.fetchQuery({
          queryKey: queryKeys.files.providers(fileId),
          queryFn: () => api.getProviders(fileId)
        });
        setProviderInfo(resp.providers);
      } catch {
        setProviderInfo([]);
      }
    },
    [queryClient]
  );

  const loadTags = useCallback(
    async (fileId: string) => {
      setTagState({ loading: true, error: null });
      try {
        const resp = await queryClient.fetchQuery({
          queryKey: queryKeys.files.tags(fileId),
          queryFn: () => api.getFileTags(fileId)
        });
        if (resp.tags.length === 0 && !tagRefreshRef.current.has(fileId)) {
          tagRefreshRef.current.add(fileId);
          const refreshed = await refreshFileTags(fileId);
          setFileTags(refreshed.tags);
        } else {
          setFileTags(resp.tags);
        }
        setTagState({ loading: false, error: null });
      } catch (err) {
        setFileTags([]);
        setTagState({ loading: false, error: (err as Error).message });
      }
    },
    [queryClient, refreshFileTags]
  );

  // ---------------------------------------------------------------------------
  // Effects: load data when selectedFile changes
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const fileId = selectedFile?.id;
    if (fileId) {
      void loadProviders(fileId);
      void loadTags(fileId);
      setMatchRemoveState({ loading: false, error: null });
    } else {
      setProviderInfo((prev) => (prev.length ? [] : prev));
      setFileTags((prev) => (prev.length ? [] : prev));
    }
  }, [selectedFile?.id, loadTags, loadProviders]);

  // ---------------------------------------------------------------------------
  // Effects: scroll restore
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (selectedFile) {
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      return;
    }
    // Defer to the next frame: the gallery remounts when the detail closes, so
    // scrolling synchronously would land on a not-yet-laid-out page and clamp
    // to the top.
    const raf = requestAnimationFrame(() => {
      window.scrollTo({
        top: savedGalleryScrollRef.current,
        behavior: 'instant' as ScrollBehavior
      });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile?.id]);

  // ---------------------------------------------------------------------------
  // Effects: nav peek + reset on file change
  // ---------------------------------------------------------------------------

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

  useEffect(() => {
    setNavPeek(false);
    setMediaFullscreen(false);
    resetDetailSwipe();
    if (!selectedFile) return;
    setNavPeek(true);
    const timer = window.setTimeout(() => setNavPeek(false), 1200);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetDetailSwipe, selectedFile?.id]);

  useEffect(() => {
    return () => clearDetailSwipeTimer();
  }, [clearDetailSwipeTimer]);

  // ---------------------------------------------------------------------------
  // Effects: body scroll lock when fullscreen or swipe-locked
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!mediaFullscreen && !detailSwipeLocked) return;
    const bodyStyle = document.body.style;
    const htmlStyle = document.documentElement.style;
    const prevBody = {
      overflow: bodyStyle.overflow,
      overscrollBehavior: bodyStyle.overscrollBehavior
    };
    const prevHtml = {
      overflow: htmlStyle.overflow,
      overscrollBehavior: htmlStyle.overscrollBehavior
    };
    bodyStyle.overflow = 'hidden';
    bodyStyle.overscrollBehavior = 'none';
    htmlStyle.overflow = 'hidden';
    htmlStyle.overscrollBehavior = 'none';
    return () => {
      bodyStyle.overflow = prevBody.overflow;
      bodyStyle.overscrollBehavior = prevBody.overscrollBehavior;
      htmlStyle.overflow = prevHtml.overflow;
      htmlStyle.overscrollBehavior = prevHtml.overscrollBehavior;
    };
  }, [detailSwipeLocked, mediaFullscreen]);

  // ---------------------------------------------------------------------------
  // Effects: keyboard navigation
  // ---------------------------------------------------------------------------

  const closeFile = useCallback(
    (options?: { syncUrl?: boolean }) => {
      if (historyMode === 'browser' && historyActiveRef.current) {
        historyActiveRef.current = false;
        window.history.back();
      }
      setSelectedFile(null);
      if (historyMode === 'external' && options?.syncUrl !== false) {
        onExternalClose?.();
      }
    },
    [historyMode, onExternalClose]
  );

  const onDeleteFile = useCallback(
    async (fileId: string) => {
      if (!window.confirm('Delete this file from disk? This cannot be undone.'))
        return;
      const nextFile =
        selectedFile?.id === fileId
          ? (gallery.files[gallery.currentIndex + 1] ??
            gallery.files[gallery.currentIndex - 1] ??
            null)
          : null;
      setDeleteState({ loading: true, error: null });
      try {
        const result = await deleteFileMutation.mutateAsync(fileId);
        if (selectedFile?.id === fileId) {
          if (nextFile) {
            setSelectedFile(nextFile);
          } else {
            closeFile();
          }
        }
        setDeleteState({ loading: false, error: null });
        if (result.errors?.length) {
          // The file IS deleted; these are post-delete cleanup issues. The
          // backend prefixes each (e.g. "Unfavorite …", "Thumb delete …"), so
          // surface them verbatim instead of mislabelling them all as a remote
          // favorite failure.
          toast.warning('Deleted, but some cleanup steps failed', {
            description: result.errors.join('\n')
          });
        } else {
          toast.success('File deleted');
        }
      } catch (err) {
        setDeleteState({ loading: false, error: null });
        toast.error('Delete failed', { description: (err as Error).message });
      }
    },
    [selectedFile, gallery, deleteFileMutation, closeFile]
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!selectedFile) return;
      if (e.target instanceof HTMLElement) {
        const tag = e.target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          e.target.isContentEditable
        ) {
          return;
        }
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        gallery.goRelative(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        gallery.goRelative(1);
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
  }, [selectedFile, gallery, mediaFullscreen, closeFile, onDeleteFile]);

  // ---------------------------------------------------------------------------
  // Effects: popstate (browser back)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (historyMode !== 'browser') return;
    const handlePopState = () => {
      if (historyActiveRef.current) {
        historyActiveRef.current = false;
        setSelectedFile(null);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [historyMode]);

  // ---------------------------------------------------------------------------
  // Swipe commit
  // ---------------------------------------------------------------------------

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
      const width =
        detailSwipeFrameRef.current?.clientWidth || window.innerWidth || 1;
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

  // ---------------------------------------------------------------------------
  // Touch handlers
  // ---------------------------------------------------------------------------

  const onDetailTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      if (
        mediaFullscreen ||
        detailSwipeTransition ||
        event.touches.length !== 1
      )
        return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, a, input, textarea, select, label, video'))
        return;
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
      if (!gesture.active || event.touches.length !== 1 || mediaFullscreen)
        return;
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
    const width =
      detailSwipeFrameRef.current?.clientWidth || window.innerWidth || 1;
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
  }, [
    clearDetailSwipeTimer,
    commitDetailSwipe,
    nextLoadedFile,
    prevLoadedFile
  ]);

  // ---------------------------------------------------------------------------
  // openFile
  // ---------------------------------------------------------------------------

  const openFile = useCallback(
    (file: FileItem) => {
      savedGalleryScrollRef.current = nextSavedGalleryScroll({
        hasOpenFile: Boolean(selectedFile),
        currentScroll: window.scrollY,
        savedScroll: savedGalleryScrollRef.current
      });
      if (historyMode === 'browser' && !historyActiveRef.current) {
        window.history.pushState({ detail: true }, '', window.location.href);
        historyActiveRef.current = true;
      }
      setSelectedFile(file);
    },
    [historyMode, selectedFile]
  );

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const onToggleFavorite = useCallback(async () => {
    if (!selectedFile) return;
    const nextFavorite = !selectedFile.isFavorite;
    setFavoriteState({ loading: true, error: null });
    try {
      const resp = await updateFileFavoriteMutation.mutateAsync({
        fileId: selectedFile.id,
        favorite: nextFavorite
      });
      setSelectedFile((prev) =>
        prev && prev.id === selectedFile.id
          ? { ...prev, isFavorite: resp.isFavorite }
          : prev
      );
      setFavoriteState({ loading: false, error: null });
    } catch (err) {
      setFavoriteState({ loading: false, error: (err as Error).message });
    }
  }, [selectedFile, updateFileFavoriteMutation]);

  const onDownloadFile = useCallback(async () => {
    if (!selectedFile) return;
    const fileName = selectedFileName || `file-${selectedFile.id}`;
    const url = api.getFileContentUrl(selectedFile.id, { download: true });
    setShareState({ loading: true, error: null });
    try {
      const blob = await api.getFileContentBlob(selectedFile.id, {
        download: true
      });
      const file = new File([blob], fileName, {
        type: blob.type || guessMimeType(fileName, selectedFile.mediaType)
      });
      if (navigator.share) {
        try {
          await navigator.share({ files: [file], title: fileName });
          setShareState({ loading: false, error: null });
          return;
        } catch (shareErr) {
          if (
            shareErr instanceof DOMException &&
            shareErr.name === 'AbortError'
          ) {
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
  }, [selectedFile, selectedFileName]);

  const onRunAllProviders = useCallback(async () => {
    if (!selectedFile) return;
    setProviderState({ loading: true, error: null });
    const fileId = selectedFile.id;
    try {
      const results = await Promise.allSettled([
        api.runProvider(fileId, 'saucenao'),
        api.runProvider(fileId, 'fluffle')
      ]);
      await loadProviders(fileId);
      await loadTags(fileId);
      const failure = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );
      const error = failure
        ? failure.reason instanceof Error
          ? failure.reason.message
          : String(failure.reason)
        : null;
      setProviderState({ loading: false, error });
    } catch (err) {
      setProviderState({ loading: false, error: (err as Error).message });
    }
  }, [selectedFile, loadProviders, loadTags]);

  const refreshTags = useCallback(async () => {
    if (!selectedFile) return;
    setTagState({ loading: true, error: null });
    try {
      const refreshed = await refreshFileTags(selectedFile.id);
      setFileTags(refreshed.tags);
      tagRefreshRef.current.add(selectedFile.id);
      setTagState({ loading: false, error: null });
    } catch (err) {
      setTagState({ loading: false, error: (err as Error).message });
    }
  }, [selectedFile, refreshFileTags]);

  const addManualTag = useCallback(async () => {
    if (!selectedFile) return;
    const value = manualTagInput.trim();
    if (!value) return;
    setTagState({ loading: true, error: null });
    try {
      await addManualTagMutation.mutateAsync({
        fileId: selectedFile.id,
        tag: value,
        category: manualTagCategory
      });
      setManualTagInput('');
      await loadTags(selectedFile.id);
      setTagState({ loading: false, error: null });
    } catch (err) {
      setTagState({ loading: false, error: (err as Error).message });
    }
  }, [
    selectedFile,
    manualTagInput,
    manualTagCategory,
    addManualTagMutation,
    loadTags
  ]);

  const removeManualTag = useCallback(
    async (tag: string, category: string) => {
      if (!selectedFile) return;
      setTagState({ loading: true, error: null });
      try {
        await removeManualTagMutation.mutateAsync({
          fileId: selectedFile.id,
          tag,
          category
        });
        await loadTags(selectedFile.id);
        setTagState({ loading: false, error: null });
      } catch (err) {
        setTagState({ loading: false, error: (err as Error).message });
      }
    },
    [selectedFile, removeManualTagMutation, loadTags]
  );

  const removeTopMatch = useCallback(
    async (sourceUrl: string) => {
      if (!selectedFile) return;
      setMatchRemoveState({ loading: true, error: null });
      try {
        const resp = await removeTopMatchMutation.mutateAsync({
          fileId: selectedFile.id,
          sourceUrl
        });
        setProviderInfo(resp.providers);
        setFileTags(resp.tags);
        tagRefreshRef.current.add(selectedFile.id);
        setMatchRemoveState({ loading: false, error: null });
      } catch (err) {
        setMatchRemoveState({ loading: false, error: (err as Error).message });
      }
    },
    [selectedFile, removeTopMatchMutation]
  );

  // ---------------------------------------------------------------------------
  // renderFileMedia helper
  // ---------------------------------------------------------------------------

  const renderFileMedia = useCallback((file: FileItem): ReactNode => {
    if (file.mediaType === 'VIDEO') {
      return createElement('video', {
        src: `${API_BASE}/files/${file.id}/content`,
        controls: true,
        loop: true,
        playsInline: true,
        preload: 'metadata',
        className: 'file-detail-media'
      });
    }
    return createElement('img', {
      src: `${API_BASE}/files/${file.id}/content`,
      alt: file.path,
      className: 'file-detail-media'
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Assemble panelProps — must match FileDetailPanel.Props exactly
  // ---------------------------------------------------------------------------

  const panelProps = useMemo<FileDetailPanelProps>(() => {
    // selectedFile is guaranteed non-null when FileDetailPanel renders
    // (App.tsx only mounts it when selectedFile truthy), but the type
    // requires FileItem (not null). Use a fallback object to satisfy TS
    // without casting; App.tsx must guard before spreading.
    const file = selectedFile!;

    return {
      selectedFile: file,
      selectedFileName,
      selectedFileType,
      selectedFileFavorite,

      mediaFullscreen,
      onToggleFullscreen: () => setMediaFullscreen((prev) => !prev),

      hasPrev,
      hasNext,
      navPeek,
      prevLoadedFile,
      nextLoadedFile,

      detailSwipeFrameRef,
      detailSwipeOffset,
      detailSwipeTransition,
      onDetailTouchStart,
      onDetailTouchMove,
      onDetailTouchEnd,

      shareState,
      favoriteState,
      deleteState,
      tagState,
      providerState,
      matchRemoveState,

      tagGroups,
      tagSourceSummary,
      manualTagInput,
      manualTagCategory,
      onManualTagInputChange: (value: string) => setManualTagInput(value),
      onManualTagCategoryChange: (value: string) => setManualTagCategory(value),
      onAddManualTag: () => void addManualTag(),
      onRemoveManualTag: (tag: string, category: string) =>
        void removeManualTag(tag, category),
      onRefreshTags: () => void refreshTags(),

      providerHighlights,
      providerMeta,
      nextAutoScanText,
      displayFilterActive,
      onRunAllProviders: () => void onRunAllProviders(),
      onRemoveTopMatch: (sourceUrl: string) => void removeTopMatch(sourceUrl),

      onDownloadFile: () => void onDownloadFile(),
      onToggleFavorite: () => void onToggleFavorite(),
      onDeleteFile: (id: string) => void onDeleteFile(id),
      onClose: closeFile,
      onGoRelative: (delta: number) => gallery.goRelative(delta),

      renderFileMedia
    };
  }, [
    selectedFile,
    selectedFileName,
    selectedFileType,
    selectedFileFavorite,
    mediaFullscreen,
    hasPrev,
    hasNext,
    navPeek,
    prevLoadedFile,
    nextLoadedFile,
    detailSwipeOffset,
    detailSwipeTransition,
    onDetailTouchStart,
    onDetailTouchMove,
    onDetailTouchEnd,
    shareState,
    favoriteState,
    deleteState,
    tagState,
    providerState,
    matchRemoveState,
    tagGroups,
    tagSourceSummary,
    manualTagInput,
    manualTagCategory,
    addManualTag,
    removeManualTag,
    refreshTags,
    providerHighlights,
    providerMeta,
    nextAutoScanText,
    displayFilterActive,
    onRunAllProviders,
    removeTopMatch,
    onDownloadFile,
    onToggleFavorite,
    onDeleteFile,
    closeFile,
    gallery,
    renderFileMedia
  ]);

  return {
    selectedFile,
    openFile,
    closeFile,
    panelProps
  };
}
