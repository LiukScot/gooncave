import { useQueryClient } from '@tanstack/react-query';
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent
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
import { useDetailScrollRestore } from './useDetailScrollRestore';
import { useBodyScrollLock, useDetailSwipe } from './useDetailSwipe';
import {
  restartVideoLoop,
  rewindVideoBeforeEnd,
  togglePlayback
} from './videoLoop';
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
import { appendTagTerm } from '@/features/library/tagInputTokens';
import {
  actionForKey,
  isBindableEvent,
  targetOwnsKey
} from '@/features/shortcuts/shortcuts';
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

/**
 * How long a delete stays undoable before the file is actually removed from
 * disk. Longer than the vote's window: a wrong delete cannot be re-done.
 */
const DELETE_UNDO_WINDOW_MS = 8_000;

// Capability, not state: it cannot change while the tab is open.
const shareSupported = canShareFiles();

/**
 * Only reached when the server sent no Content-Type. With no extension to go
 * on it returns '' rather than a wildcard: `video/*` is not a MIME type, and
 * a File built with one is rejected by the iOS share sheet outright instead
 * of falling back to sniffing (issue #303).
 */
const guessMimeType = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (!ext) return '';
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
  /** Puts a file the gallery pruned back at its old index, on undo. */
  onFileRestored: (file: FileItem, index: number) => void;
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
    onFileDeleted,
    onFileRestored
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

  const currentVideoRef = useRef<HTMLVideoElement | null>(null);

  // --- nav peek ------------------------------------------------------------
  const [navPeek, setNavPeek] = useState(false);

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

  // The swipe only reports the gesture; which file it lands on is decided
  // here, once the outgoing panel has finished sliding away.
  const swipe = useDetailSwipe({
    open: Boolean(selectedFile),
    itemKey: selectedFile?.id ?? null,
    canPrev: Boolean(prevLoadedFile),
    canNext: Boolean(nextLoadedFile),
    onCommit: useCallback(
      (delta: -1 | 1) => {
        const target = delta < 0 ? prevLoadedFile : nextLoadedFile;
        if (target) setSelectedFile(target);
      },
      [nextLoadedFile, prevLoadedFile]
    )
  });

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

  const rememberGalleryScroll = useDetailScrollRestore(
    selectedFile?.id ?? null
  );

  // ---------------------------------------------------------------------------
  // Effects: nav peek + reset on file change
  // ---------------------------------------------------------------------------

  useEffect(() => {
    setNavPeek(false);
    if (!selectedFile) return;
    setNavPeek(true);
    const timer = window.setTimeout(() => setNavPeek(false), 1200);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile?.id]);

  useBodyScrollLock(mediaFullscreen || swipe.locked);

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

  // A delete is applied to the list at once and sent when the undo window
  // closes, the same shape the vote uses — there is no undelete endpoint, so
  // not having sent it yet is what makes Undo possible at all.
  const pendingDeleteRef = useRef<{
    file: FileItem;
    index: number;
    timer: number;
  } | null>(null);

  const commitDelete = useCallback(() => {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingDeleteRef.current = null;
    setDeleteState({ loading: true, error: null });
    deleteFileMutation
      .mutateAsync(pending.file.id)
      .then((result) => {
        setDeleteState({ loading: false, error: null });
        if (result.errors?.length) {
          // The file IS deleted; these are post-delete cleanup issues. The
          // backend prefixes each (e.g. "Unfavorite …", "Thumb delete …"), so
          // surface them verbatim instead of mislabelling them all as a remote
          // favorite failure.
          toast.warning('Deleted, but some cleanup steps failed', {
            description: result.errors.join('\n')
          });
        }
      })
      .catch((err: Error) => {
        setDeleteState({ loading: false, error: null });
        // The file is still on disk, so the list must show it again.
        onFileRestored(pending.file, pending.index);
        toast.error('Delete failed', { description: err.message });
      });
  }, [deleteFileMutation, onFileRestored]);

  const commitDeleteRef = useRef(commitDelete);
  useEffect(() => {
    commitDeleteRef.current = commitDelete;
  }, [commitDelete]);

  // Leaving the page must send the pending delete rather than drop it.
  useEffect(() => () => commitDeleteRef.current(), []);

  const undoDelete = useCallback(() => {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingDeleteRef.current = null;
    onFileRestored(pending.file, pending.index);
  }, [onFileRestored]);

  const onDeleteFile = useCallback(
    async (fileId: string) => {
      const confirmed = await confirm('Delete this file from disk?', {
        title: 'Delete file',
        confirmLabel: 'Delete',
        destructive: true
      });
      if (!confirmed) return;
      // Only one delete waits at a time: a second one sends the first.
      commitDeleteRef.current();
      const index = gallery.files.findIndex((file) => file.id === fileId);
      const file = index === -1 ? null : gallery.files[index];
      if (!file) return;
      const nextFile =
        selectedFile?.id === fileId
          ? (gallery.files[index + 1] ?? gallery.files[index - 1] ?? null)
          : null;
      onFileDeleted(fileId);
      if (selectedFile?.id === fileId) {
        if (nextFile) setSelectedFile(nextFile);
        else closeFile();
      }
      const timer = window.setTimeout(
        () => commitDeleteRef.current(),
        DELETE_UNDO_WINDOW_MS
      );
      pendingDeleteRef.current = { file, index, timer };
      toast.success('File deleted', {
        duration: DELETE_UNDO_WINDOW_MS,
        action: { label: 'Undo', onClick: undoDelete }
      });
    },
    [selectedFile, gallery, closeFile, confirm, onFileDeleted, undoDelete]
  );

  // ---------------------------------------------------------------------------
  // openFile
  // ---------------------------------------------------------------------------

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
      if (
        targetOwnsKey(e.target instanceof HTMLElement ? e.target : null, e.key)
      ) {
        return;
      }
      const action = actionForKey(shortcuts, 'detail', e.key);
      if (!action) return;
      if (action === 'playPause') {
        // Swallow the key only when there was a video to toggle: on a
        // picture, space must still scroll the panel.
        if (togglePlayback(currentVideoRef.current)) e.preventDefault();
        return;
      }
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
        type: blob.type || guessMimeType(fileName)
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
        // Released before the sheet opens, not after: on iOS the promise
        // below can stay pending for good once the page is backgrounded by
        // the app the user picked, which left the button disabled until the
        // browser was restarted (issue #303). Nothing after this point needs
        // the button held anyway — the sheet is the progress indicator.
        setShareState({ loading: false, error: null });
        try {
          // No `title`/`text`: apps that accept both attach the file *and*
          // post the title as a separate message.
          await navigator.share({ files: [file] });
          return;
        } catch (shareErr) {
          if (
            shareErr instanceof DOMException &&
            shareErr.name === 'AbortError'
          ) {
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
   * Runs the gallery search off a tag pill. Search adds the tag to whatever
   * is already in the box rather than replacing it: a query is built one
   * pill at a time, and clearing it is what the box itself is for (#307).
   */
  const selectTag = useCallback(
    async (tag: string) => {
      const mode = await choose('', {
        title: tag,
        actions: [
          { value: 'search', label: 'Search' },
          { value: 'subscribe', label: 'Subscribe' }
        ]
      });
      if (!mode) return;
      if (mode === 'subscribe') {
        toast.info('Subscriptions are not available yet.');
        return;
      }
      const next = appendTagTerm(
        useGalleryUiStore.getState().galleryTagInput,
        tag
      );
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
          // Only the current panel renders a <video> — the neighbours are
          // thumbnails — so this always points at the open file.
          currentVideoRef.current = element;
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

      detailSwipeFrameRef: swipe.frameRef,
      detailSwipeOffset: swipe.offset,
      detailSwipeTransition: swipe.transitioning,
      onDetailTouchStart: swipe.onTouchStart,
      onDetailTouchEnd: swipe.onTouchEnd,

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
    swipe,
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
