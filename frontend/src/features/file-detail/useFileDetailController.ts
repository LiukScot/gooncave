import { useQueryClient } from '@tanstack/react-query';
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
  type TouchEvent as ReactTouchEvent
} from 'react';
import { toast } from 'sonner';

import type {
  FetchState,
  Props as FileDetailPanelProps,
  ProviderMeta,
  TagEntry
} from './FileDetailPanel';
import {
  buildProviderHighlights,
  buildTagGroups,
  buildTagSourceSummary,
  canonicalizeSauceKey,
  providerScoreThresholds,
  resolveProviderScore,
  sauceKeyFromResult,
  type ProviderKind
} from './sections';
import { canShareFiles } from './share';
import { restartVideoLoop, rewindVideoBeforeEnd } from './videoLoop';
import { readVideoSound, writeVideoSound } from './videoVolume';
import {
  formatVoteCooldown,
  useNow,
  VOTE_COOLDOWN_MS,
  VOTE_UNDO_WINDOW_MS
} from './vote';

import {
  api,
  API_BASE,
  type FileItem,
  type FileTag,
  type ProviderRun,
  type SauceSettings
} from '@/api';
import {
  useChoose,
  useConfirm,
  useDialogOpen
} from '@/components/confirm-dialog';
import { actionForKey, isBindableEvent } from '@/features/shortcuts/shortcuts';
import { useShortcuts } from '@/features/shortcuts/useShortcuts';
import { useBooruSites } from '@/hooks/booru-sites';
import { useDeleteFile, useFileProviders, useVoteFile } from '@/hooks/files';
import { useExtraSettings } from '@/hooks/settings';
import {
  useAddManualTag,
  useFileTags,
  useRefreshFileTags,
  useRemoveTopMatch,
  useSuppressFileTags
} from '@/hooks/tags';
import { basenameFromPath } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { useGalleryUiStore } from '@/stores/galleryUiStore';

// ---------------------------------------------------------------------------
// Local constants (mirrored from App.tsx — keep in sync)
// ---------------------------------------------------------------------------

const providerKinds: readonly ProviderKind[] = ['SAUCENAO', 'FLUFFLE'];
type DetailSwipeAxis = 'idle' | 'x' | 'y';

// Capability, not state: it cannot change while the tab is open.
const shareSupported = canShareFiles();

/** Reads `--file-detail-video-controls` (see app.css), which is in px. */
const nativeVideoControlsHeight = (video: Element): number =>
  parseFloat(
    getComputedStyle(video).getPropertyValue('--file-detail-video-controls')
  ) || 0;

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
};

export type FileDetailControllerInput = {
  gallery: FileDetailGalleryDep;
  sauceSettings: SauceSettings;
  /** Owned by the URL (`fs` search param) so the back gesture exits it. */
  mediaFullscreen: boolean;
  onFullscreenChange: (next: boolean) => void;
  onClose: () => void;
  /** Fires only once the file is gone from disk, never on a cancelled or
   * failed delete. The gallery list prunes the file from here. */
  onFileDeleted: (fileId: string) => void;
};

export type FileDetailControllerOutput = {
  selectedFile: FileItem | null;
  openFile: (file: FileItem) => void;
  /** Call from the gallery, before opening a file, to restore its scroll on close. */
  rememberGalleryScroll: () => void;
  closeFile: (options?: { syncUrl?: boolean }) => void;
  // Same handler the panel gets, exposed for callers outside it. The vote is
  // held for the undo window before it is sent, so this returns immediately
  // and never reports the settled result; the gallery follows selectedFile
  // instead.
  onVote: (value: 1 | -1) => void;
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
    mediaFullscreen,
    onFullscreenChange,
    onClose,
    onFileDeleted
  } = input;
  const queryClient = useQueryClient();
  const { voteSystemEnabled } = useExtraSettings();

  // --- mutations -----------------------------------------------------------
  const deleteFileMutation = useDeleteFile();
  const confirm = useConfirm();
  const choose = useChoose();
  const dialogOpen = useDialogOpen();
  const shortcuts = useShortcuts();
  const voteFileMutation = useVoteFile();
  const addManualTagMutation = useAddManualTag();
  const suppressFileTagsMutation = useSuppressFileTags();
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
  const [voteState, setVoteState] = useState<FetchState>({
    loading: false,
    error: null
  });
  const [pendingVote, setPendingVote] = useState<1 | -1 | null>(null);
  const pendingVoteRef = useRef<{
    fileId: string;
    value: 1 | -1;
    previous: { voteScore: number; nextVoteAt: string | null };
    timer: number;
  } | null>(null);
  const commitVoteRef = useRef<() => void>(() => {});
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
  const [impliedTags, setImpliedTags] = useState<string[]>([]);
  const [tagsEditing, setTagsEditing] = useState(false);

  // --- tag editor ----------------------------------------------------------
  const [manualTagInput, setManualTagInput] = useState('');
  const [manualTagCategory, setManualTagCategory] = useState('general');

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
  const voteScore = selectedFile?.voteScore ?? 0;
  // A minute is finer than the countdown's own resolution, so the label never
  // sits visibly stale, and it costs one re-render per minute.
  const now = useNow(60_000);
  const voteCooldownText = formatVoteCooldown(
    selectedFile?.nextVoteAt ?? null,
    now
  );

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

  const tagGroups = useMemo(() => buildTagGroups(fileTags), [fileTags]);

  const tagSourceSummary = useMemo(
    () => buildTagSourceSummary(fileTags, booruSiteNameById),
    [booruSiteNameById, fileTags]
  );

  // ---------------------------------------------------------------------------
  // Provider highlights (derived from providerInfo + sauce settings)
  // ---------------------------------------------------------------------------

  const highlightContext = useMemo(
    () => ({ displayFilterActive, displaySet, booruSiteNameById }),
    [booruSiteNameById, displayFilterActive, displaySet]
  );

  const providerHighlights = useMemo(
    () => buildProviderHighlights(providerInfo, highlightContext),
    [highlightContext, providerInfo]
  );

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
          setImpliedTags(refreshed.implied);
        } else {
          setFileTags(resp.tags);
          setImpliedTags(resp.implied);
        }
        setTagState({ loading: false, error: null });
      } catch (err) {
        setFileTags([]);
        setImpliedTags([]);
        setTagState({ loading: false, error: (err as Error).message });
      }
    },
    [queryClient, refreshFileTags]
  );

  // The neighbours are fetched, not just prefetched: the preview panels show
  // their tags and matches while the swipe is in flight, so a file slides in
  // already filled instead of carrying empty sections that only populate once
  // it becomes current.
  const prevTags = useFileTags(prevLoadedFile?.id ?? null);
  const nextTags = useFileTags(nextLoadedFile?.id ?? null);
  const prevProviders = useFileProviders(prevLoadedFile?.id ?? null);
  const nextProviders = useFileProviders(nextLoadedFile?.id ?? null);

  const buildPreviewSections = useCallback(
    (
      tags: readonly FileTag[] | undefined,
      providers: readonly ProviderRun[] | undefined
    ) => ({
      tagGroups: buildTagGroups(tags ?? []),
      tagSourceSummary: buildTagSourceSummary(tags ?? [], booruSiteNameById),
      providerHighlights: buildProviderHighlights(
        providers ?? [],
        highlightContext
      )
    }),
    [booruSiteNameById, highlightContext]
  );

  const prevSections = useMemo(
    () =>
      buildPreviewSections(prevTags.data?.tags, prevProviders.data?.providers),
    [buildPreviewSections, prevProviders.data, prevTags.data]
  );
  const nextSections = useMemo(
    () =>
      buildPreviewSections(nextTags.data?.tags, nextProviders.data?.providers),
    [buildPreviewSections, nextProviders.data, nextTags.data]
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
    // to the top. The page then keeps growing as tiles lay out, and a clamped
    // scroll does not catch up on its own — so retry until the target is
    // actually reached. Budget in milliseconds, not frames: a frame count is a
    // wall-clock budget that shrinks exactly when layout is slowest (a loaded
    // machine drops frames), which made this give up early and land short.
    const RESTORE_TIMEOUT_MS = 3_000;
    // Reaching the offset once is not enough to keep it. The router scrolls to
    // 0,0 when it commits the location this close is navigating to, and that
    // lands a few ms either side of the restore — before it on a fast machine,
    // after it on a slow one, where it silently undid the whole thing. Hold
    // the position briefly instead of racing for who writes last.
    const HOLD_MS = 500;
    const startedAt = performance.now();
    let reachedAt: number | null = null;
    let rafId: number;
    let stopped = false;
    // A restore that keeps yanking the page back would fight a user who
    // started scrolling on their own; their input wins.
    const abort = () => {
      stopped = true;
    };
    window.addEventListener('wheel', abort, { passive: true, once: true });
    window.addEventListener('touchstart', abort, { passive: true, once: true });
    const stopListening = () => {
      window.removeEventListener('wheel', abort);
      window.removeEventListener('touchstart', abort);
    };

    const restore = () => {
      const target = savedGalleryScrollRef.current;
      if (Math.abs(window.scrollY - target) > 1) {
        window.scrollTo({ top: target, behavior: 'instant' as ScrollBehavior });
      }
      const now = performance.now();
      if (Math.abs(window.scrollY - target) <= 1) {
        reachedAt ??= now;
      }
      const held = reachedAt !== null && now - reachedAt >= HOLD_MS;
      if (!held && !stopped && now - startedAt < RESTORE_TIMEOUT_MS) {
        rafId = requestAnimationFrame(restore);
        return;
      }
      stopListening();
    };
    rafId = requestAnimationFrame(restore);
    return () => {
      cancelAnimationFrame(rafId);
      stopListening();
    };
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
      setSelectedFile(null);
      if (options?.syncUrl !== false) {
        onClose();
      }
    },
    [onClose]
  );

  const onDeleteFile = useCallback(
    async (fileId: string) => {
      const confirmed = await confirm(
        'Delete this file from disk? This cannot be undone.',
        { title: 'Delete file', confirmLabel: 'Delete', destructive: true }
      );
      if (!confirmed) return;
      const nextFile =
        selectedFile?.id === fileId
          ? (gallery.files[gallery.currentIndex + 1] ??
            gallery.files[gallery.currentIndex - 1] ??
            null)
          : null;
      setDeleteState({ loading: true, error: null });
      try {
        const result = await deleteFileMutation.mutateAsync(fileId);
        onFileDeleted(fileId);
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
    [
      selectedFile,
      gallery,
      deleteFileMutation,
      closeFile,
      confirm,
      onFileDeleted
    ]
  );

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
    (event: ReactTouchEvent<HTMLDivElement>) => {
      if (detailSwipeTransition || event.touches.length !== 1) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('button, a, input, textarea, select, label')) return;
      const touch = event.touches[0];
      // A video used to be excluded outright, to keep a drag on the native
      // seek bar from turning into a file swipe. In fullscreen the video
      // covers the screen, so that left no surface to swipe from at all.
      // Guard only the strip the native controls actually occupy.
      const video = target?.closest('video');
      if (
        video &&
        touch.clientY >
          video.getBoundingClientRect().bottom -
            nativeVideoControlsHeight(video)
      ) {
        return;
      }
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
    [clearDetailSwipeTimer, detailSwipeTransition]
  );

  const onDetailTouchMove = useCallback(
    (event: globalThis.TouchEvent) => {
      const gesture = detailGestureRef.current;
      if (!gesture.active || event.touches.length !== 1) return;
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
    [nextLoadedFile, prevLoadedFile]
  );

  // React registers `touchmove` on its root as a passive listener, so the
  // preventDefault() above is ignored there and the page keeps scrolling
  // vertically mid-swipe. Bind it natively instead. The handler is read
  // through a ref so a new callback identity does not detach the listener
  // in the middle of a gesture.
  const onDetailTouchMoveRef = useRef(onDetailTouchMove);
  onDetailTouchMoveRef.current = onDetailTouchMove;

  const detailPanelOpen = Boolean(selectedFile);

  useEffect(() => {
    const frame = detailSwipeFrameRef.current;
    if (!detailPanelOpen || !frame) return;
    const handler = (event: globalThis.TouchEvent) =>
      onDetailTouchMoveRef.current(event);
    frame.addEventListener('touchmove', handler, { passive: false });
    return () => frame.removeEventListener('touchmove', handler);
  }, [detailPanelOpen]);

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

  // Only the gallery itself knows it is the view being scrolled away from, so
  // it is the only caller allowed to record the position. openFile must not
  // infer it: prev/next and the URL sync both re-open files while the window
  // is already pinned to the top of the detail view, and the URL sync can do
  // so right after a transient deselection — inferring from "no file is
  // selected" reads that moment as a fresh gallery open and overwrites the
  // real position with 0.
  const rememberGalleryScroll = useCallback(() => {
    savedGalleryScrollRef.current = window.scrollY;
  }, []);

  const openFile = useCallback((file: FileItem) => {
    setSelectedFile(file);
  }, []);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  // A vote is held locally for VOTE_UNDO_WINDOW_MS before it is sent, which
  // is what makes "Undo" possible without an undo endpoint (and without a way
  // to bypass the server-side cooldown).
  const commitVote = useCallback(() => {
    const pending = pendingVoteRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingVoteRef.current = null;
    setPendingVote(null);
    setVoteState({ loading: true, error: null });
    voteFileMutation
      .mutateAsync({ fileId: pending.fileId, value: pending.value })
      .then((resp) => {
        setSelectedFile((prev) =>
          prev && prev.id === pending.fileId
            ? {
                ...prev,
                voteScore: resp.voteScore,
                nextVoteAt: resp.nextVoteAt
              }
            : prev
        );
        setVoteState({ loading: false, error: null });
      })
      .catch((err: Error) => {
        setSelectedFile((prev) =>
          prev && prev.id === pending.fileId
            ? { ...prev, ...pending.previous }
            : prev
        );
        setVoteState({ loading: false, error: err.message });
      });
  }, [voteFileMutation]);

  useEffect(() => {
    commitVoteRef.current = commitVote;
  }, [commitVote]);

  // Leaving the file (swipe, close, unmount) must send the pending vote
  // rather than drop it silently.
  useEffect(() => {
    if (
      pendingVoteRef.current &&
      pendingVoteRef.current.fileId !== selectedFile?.id
    ) {
      commitVoteRef.current();
    }
  }, [selectedFile?.id]);

  useEffect(() => () => commitVoteRef.current(), []);

  const onVote = useCallback(
    (value: 1 | -1) => {
      if (!selectedFile || pendingVoteRef.current) return;
      const fileId = selectedFile.id;
      const previous = {
        voteScore: selectedFile.voteScore,
        nextVoteAt: selectedFile.nextVoteAt
      };
      setVoteState({ loading: false, error: null });
      setSelectedFile((prev) =>
        prev && prev.id === fileId
          ? {
              ...prev,
              voteScore: prev.voteScore + value,
              nextVoteAt: new Date(Date.now() + VOTE_COOLDOWN_MS).toISOString()
            }
          : prev
      );
      const timer = window.setTimeout(
        () => commitVoteRef.current(),
        VOTE_UNDO_WINDOW_MS
      );
      pendingVoteRef.current = { fileId, value, previous, timer };
      setPendingVote(value);
    },
    [selectedFile]
  );

  const onUndoVote = useCallback(() => {
    const pending = pendingVoteRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingVoteRef.current = null;
    setPendingVote(null);
    setSelectedFile((prev) =>
      prev && prev.id === pending.fileId
        ? { ...prev, ...pending.previous }
        : prev
    );
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!selectedFile) return;
      // A dialog owns the keyboard while it is up: without this, Esc would
      // dismiss the dialog and close the file behind it in one press.
      if (dialogOpen) return;
      if (!isBindableEvent(e)) return;
      if (e.target instanceof HTMLElement) {
        const tag = e.target.tagName;
        // A field takes every key: typing must never navigate the gallery.
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          e.target.isContentEditable
        ) {
          return;
        }
        // A button, link or video only takes the keys that activate it.
        // Clicking any control leaves it focused, so excluding these
        // wholesale would kill the arrows for the rest of the visit.
        const activates = e.key === ' ' || e.key === 'Enter';
        if (activates && (tag === 'BUTTON' || tag === 'A' || tag === 'VIDEO')) {
          return;
        }
      }
      const action = actionForKey(shortcuts, 'detail', e.key);
      if (!action) return;
      e.preventDefault();
      if (action === 'prev') {
        gallery.goRelative(-1);
      } else if (action === 'next') {
        gallery.goRelative(1);
      } else if (action === 'close') {
        if (mediaFullscreen) {
          onFullscreenChange(false);
        } else {
          closeFile();
        }
      } else if (action === 'fullscreen') {
        onFullscreenChange(!mediaFullscreen);
      } else if (action === 'voteUp') {
        if (voteSystemEnabled) onVote(1);
      } else if (action === 'voteDown') {
        if (voteSystemEnabled) onVote(-1);
      } else if (action === 'delete') {
        void onDeleteFile(selectedFile.id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    selectedFile,
    gallery,
    mediaFullscreen,
    closeFile,
    onDeleteFile,
    onFullscreenChange,
    shortcuts,
    dialogOpen,
    onVote,
    voteSystemEnabled
  ]);

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
      // A short read still resolves — the receiving app then gets a file it
      // cannot open. Better to hand the URL to the browser's own downloader
      // than to share a truncated video.
      const truncated =
        selectedFile.sizeBytes > 0 && blob.size !== selectedFile.sizeBytes;
      if (truncated) {
        triggerDownload(url, fileName);
        setShareState({
          loading: false,
          error: `Incomplete download (${blob.size} of ${selectedFile.sizeBytes} bytes)`
        });
        return;
      }
      if (navigator.canShare?.({ files: [file] })) {
        try {
          // No `title`/`text`: apps that accept both attach the file *and*
          // post the title as a separate message.
          await navigator.share({ files: [file] });
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
      setImpliedTags(refreshed.implied);
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

  const removeTag = useCallback(
    async (entry: TagEntry) => {
      if (!selectedFile) return;
      // The pill shows one name but can stand for several stored tags, and
      // taking five away on one click without saying so reads as a bug. The
      // dialog names every one it is about to remove.
      const confirmed = await confirm(
        'Remove this tag from this file? The tags refresh button brings it back.',
        {
          title: 'Remove tag',
          confirmLabel: 'Remove',
          destructive: true,
          details: entry.originals.join(', ')
        }
      );
      if (!confirmed) return;
      setTagState({ loading: true, error: null });
      try {
        const resp = await suppressFileTagsMutation.mutateAsync({
          fileId: selectedFile.id,
          tags: [entry.tag]
        });
        setFileTags(resp.tags);
        setImpliedTags(resp.implied);
        setTagState({ loading: false, error: null });
      } catch (err) {
        setTagState({ loading: false, error: (err as Error).message });
      }
    },
    [selectedFile, suppressFileTagsMutation, confirm]
  );

  /**
   * Adds a tag to the gallery filter. The three actions map onto the search
   * operators, so a filter that would need typing `~` or `-` by hand can be
   * built from the pills instead.
   */
  const selectTag = useCallback(
    async (tag: string) => {
      const mode = await choose('Add this tag to the gallery search?', {
        title: 'Filter by tag',
        details: tag,
        actions: [
          { value: 'all', label: 'And' },
          { value: 'any', label: 'Or' },
          { value: 'none', label: 'Exclude', variant: 'destructive' }
        ]
      });
      if (!mode) return;
      const prefix = mode === 'any' ? '~' : mode === 'none' ? '-' : '';
      const term = `${prefix}${tag}`;
      const current = useGalleryUiStore.getState().galleryTagInput.trim();
      const terms = current ? current.split(/\s+/) : [];
      if (!terms.includes(term)) terms.push(term);
      const next = terms.join(' ');
      useGalleryUiStore.getState().setGalleryTagInput(next);
      useGalleryUiStore.getState().setGalleryTagQuery(next);
      closeFile();
    },
    [choose, closeFile]
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

  // Keyed by file id so React remounts the element instead of swapping src on
  // the existing one: a reused <img>/<video> keeps painting the previous
  // frame until the new file decodes, which reads as the old image flashing
  // back after a swipe. The wrap shows the (already cached) thumbnail
  // underneath while the original loads.
  const renderFileMedia = useCallback((file: FileItem): ReactNode => {
    if (file.mediaType === 'VIDEO') {
      return createElement('video', {
        key: file.id,
        // `volume` is a DOM property, not an attribute, so React cannot set it
        // declaratively. The element is keyed by file id, so every opened
        // video picks up whatever level the player was left at last time.
        ref: (element: HTMLVideoElement | null) => {
          if (!element) return;
          const sound = readVideoSound();
          element.volume = sound.volume;
          element.muted = sound.muted;
        },
        onVolumeChange: (event: SyntheticEvent<HTMLVideoElement>) => {
          const { volume, muted } = event.currentTarget;
          writeVideoSound({ volume, muted });
        },
        onTimeUpdate: (event: SyntheticEvent<HTMLVideoElement>) => {
          rewindVideoBeforeEnd(event.currentTarget);
        },
        onEnded: (event: SyntheticEvent<HTMLVideoElement>) => {
          restartVideoLoop(event.currentTarget);
        },
        src: `${API_BASE}/files/${file.id}/content`,
        controls: true,
        playsInline: true,
        preload: 'metadata',
        className: 'file-detail-media'
      });
    }
    return createElement('img', {
      key: file.id,
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
      voteScore,
      voteCooldownText,
      voteSystemEnabled,
      pendingVote,

      mediaFullscreen,
      onToggleFullscreen: () => onFullscreenChange(!mediaFullscreen),

      hasPrev,
      hasNext,
      navPeek,
      prevLoadedFile,
      nextLoadedFile,
      prevSections,
      nextSections,

      detailSwipeFrameRef,
      detailSwipeOffset,
      detailSwipeTransition,
      onDetailTouchStart,
      onDetailTouchEnd,

      shareState,
      voteState,
      deleteState,
      tagState,
      providerState,
      matchRemoveState,

      tagGroups,
      impliedTags,
      tagSourceSummary,
      tagsEditing,
      manualTagInput,
      manualTagCategory,
      onManualTagInputChange: (value: string) => setManualTagInput(value),
      onManualTagCategoryChange: (value: string) => setManualTagCategory(value),
      onAddManualTag: () => void addManualTag(),
      onToggleTagsEditing: () => setTagsEditing((current) => !current),
      onRemoveTag: (entry: TagEntry) => void removeTag(entry),
      onSelectTag: (tag: string) => void selectTag(tag),
      onRefreshTags: () => void refreshTags(),

      providerHighlights,
      providerMeta,
      nextAutoScanText,
      displayFilterActive,
      onRunAllProviders: () => void onRunAllProviders(),
      onRemoveTopMatch: (sourceUrl: string) => void removeTopMatch(sourceUrl),

      shareSupported,
      onDownloadFile: () => void onDownloadFile(),
      onVote,
      onUndoVote,
      onDeleteFile: (id: string) => void onDeleteFile(id),
      onClose: closeFile,
      onGoRelative: (delta: number) => gallery.goRelative(delta),

      renderFileMedia
    };
  }, [
    selectedFile,
    voteScore,
    voteCooldownText,
    voteSystemEnabled,
    pendingVote,
    mediaFullscreen,
    hasPrev,
    hasNext,
    navPeek,
    prevLoadedFile,
    nextLoadedFile,
    prevSections,
    nextSections,
    detailSwipeOffset,
    detailSwipeTransition,
    onDetailTouchStart,
    onDetailTouchEnd,
    onFullscreenChange,
    shareState,
    voteState,
    deleteState,
    tagState,
    providerState,
    matchRemoveState,
    tagGroups,
    impliedTags,
    tagSourceSummary,
    tagsEditing,
    manualTagInput,
    manualTagCategory,
    addManualTag,
    removeTag,
    selectTag,
    refreshTags,
    providerHighlights,
    providerMeta,
    nextAutoScanText,
    displayFilterActive,
    onRunAllProviders,
    removeTopMatch,
    onDownloadFile,
    onVote,
    onUndoVote,
    onDeleteFile,
    closeFile,
    gallery,
    renderFileMedia
  ]);

  return {
    selectedFile,
    openFile,
    rememberGalleryScroll,
    closeFile,
    onVote,
    panelProps
  };
}
