/**
 * useFoldersController
 *
 * Owns all folders-related state, refs, mutations, and handlers that were
 * previously inline in App.tsx. Returns an object whose `panelProps` field
 * maps 1-to-1 to FoldersListPanel's Props interface.
 *
 * NOT owned here (stays in App.tsx / caller):
 * - Gallery cache clearing after upload: caller passes `onUploadComplete` which
 *   clears the cache ref and reloads the gallery.
 * - Gallery reload after scan finishes: caller passes `onScanFinished`.
 * - authRequiredEvent handler: must also reset gallery, favorites-poll, and
 *   many other feature slices — it cannot live here without coupling features.
 * - folderMap (folder lookup by id for gallery): caller derives it from the
 *   `folders` array returned here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  FolderDescriptor,
  FoldersListPanelProps
} from './FoldersListPanel';

import type { AuthUser, Folder } from '@/api';
import { useConfirm } from '@/components/confirm-dialog';
import {
  useDeleteFolder,
  useFolders,
  useUploadFolderFiles
} from '@/hooks/folders';
import { basenameFromPath } from '@/lib/format';

// ---------------------------------------------------------------------------
// Local types re-exported so callers don't need to dig into the panel file
// ---------------------------------------------------------------------------

type FetchState = { loading: boolean; error: string | null };

type FolderUploadPhase =
  'uploading' | 'processing' | 'success' | 'warning' | 'error';

type FolderUploadState = {
  phase: FolderUploadPhase;
  progress: number;
  message: string;
  detail: string | null;
};

// How long the upload result toast stays visible before auto-hiding (ms).
const FOLDER_UPLOAD_RESULT_VISIBILITY_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers (pure, no hooks)
// ---------------------------------------------------------------------------

const normalizeComparablePath = (value: string): string => {
  if (!value) return '/';
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
};

const getRelativeFolderPath = (
  folderPath: string,
  libraryRoot: string
): string | null => {
  const normalizedFolder = normalizeComparablePath(folderPath);
  const normalizedRoot = normalizeComparablePath(libraryRoot);
  if (normalizedFolder === normalizedRoot) return '';
  if (!normalizedFolder.startsWith(`${normalizedRoot}/`)) return null;
  return normalizedFolder.slice(normalizedRoot.length + 1);
};

export const describeFolder = (
  folder: Folder,
  libraryRoot: string
): FolderDescriptor => {
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
    subtitle: relativePath
      ? isDirectChild
        ? null
        : `Mounted folder: ${relativePath}`
      : 'Mounted folder',
    pathLabel: folder.path,
    filterLabel: relativePath || title
  };
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FoldersControllerInput = {
  authUser: AuthUser | null;
  libraryRoot: string;
  favoritesSettings: { favoritesRootId: string | null };
  favoritesSettingsState: FetchState;
  onUpdateFavoritesRoot: (folderId: string) => void;
  uploadInputAccept: string;
  /** Called when a folder upload finishes (success or error). Use to clear
   *  the gallery cache and trigger a gallery reload when in gallery mode. */
  onUploadComplete?: () => void;
  /** Called when a SCANNING folder transitions to non-scanning. Use to
   *  trigger a gallery reload when in gallery mode. */
  onScanFinished?: () => void;
};

export type FoldersControllerOutput = {
  /** Raw folders list from TanStack Query. */
  folders: Folder[];
  /** Folders sorted: root first, then alphabetical by filterLabel. */
  orderedFolders: Folder[];
  /** Precomputed descriptor for every folder; keyed by folder.id. */
  folderDetailsById: Map<string, FolderDescriptor>;
  /** All props required by <FoldersListPanel />. */
  panelProps: FoldersListPanelProps;
  /** Trigger a folders refetch. Pass `{ silent: true }` to skip loading
   *  spinner in the caller. Exposed so other features (gallery, file-detail)
   *  can request a refresh. */
  refreshFolders: (options?: { silent?: boolean }) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFoldersController(
  input: FoldersControllerInput
): FoldersControllerOutput {
  const {
    authUser,
    libraryRoot,
    favoritesSettings,
    favoritesSettingsState,
    onUpdateFavoritesRoot,
    uploadInputAccept,
    onUploadComplete,
    onScanFinished
  } = input;

  // ----- TanStack queries / mutations -----
  const foldersQuery = useFolders({ enabled: Boolean(authUser) });
  const deleteFolderMutation = useDeleteFolder();
  const confirm = useConfirm();
  const uploadFolderFilesMutation = useUploadFolderFiles();

  const folders = useMemo(() => foldersQuery.data ?? [], [foldersQuery.data]);

  // ----- State -----
  const [folderActionState, setFolderActionState] = useState<FetchState>({
    loading: false,
    error: null
  });
  const [folderUploads, setFolderUploads] = useState<
    Record<string, FolderUploadState>
  >({});

  // ----- Refs -----
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadFolderIdRef = useRef<string | null>(null);
  /** Map of folderId → window.setTimeout handle for hiding upload toasts. */
  const folderUploadHideTimersRef = useRef<Record<string, number>>({});
  /** setInterval handle for scan-status polling. */
  const scanPollingRef = useRef<number | null>(null);
  /** Tracks whether any folder was scanning last render so we can fire
   *  onScanFinished exactly once when scanning stops. */
  const lastScanActiveRef = useRef(false);

  // ----- Derived -----
  const folderMap = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders]
  );

  const folderDetailsById = useMemo<Map<string, FolderDescriptor>>(() => {
    const map = new Map<string, FolderDescriptor>();
    if (!authUser) return map;
    folders.forEach((folder) => {
      map.set(folder.id, describeFolder(folder, libraryRoot));
    });
    return map;
  }, [authUser, folders, libraryRoot]);

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

  // ----- Timer helpers -----

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
      }, FOLDER_UPLOAD_RESULT_VISIBILITY_MS);
    },
    [clearFolderUploadHideTimer]
  );

  // ----- refreshFolders -----

  const refreshFolders = useCallback(
    async (options: { silent?: boolean } = {}) => {
      try {
        await foldersQuery.refetch({ throwOnError: true });
      } catch (err) {
        if (!options.silent) {
          // Surface loading errors only when not in silent mode. Callers that
          // care can wrap this; here we just let the error propagate.
          throw err;
        }
      }
    },
    [foldersQuery]
  );

  // ----- Handlers -----

  const uploadFilesToFolder = useCallback(
    async (folder: Folder, files: File[]) => {
      if (!files.length) return;
      const uploadMessage =
        files.length === 1
          ? `Uploading ${files[0].name}`
          : `Uploading ${files.length} files`;

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
          onProgress: ({ percent }: { percent: number }) => {
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

        // Notify caller (App.tsx) to clear gallery cache and reload if needed.
        onUploadComplete?.();

        await refreshFolders({ silent: true });

        const uploadedCount = result.uploaded.length;
        const rejectedCount = result.rejected.length;
        const rejectedDetail = rejectedCount
          ? result.rejected
              .map((entry) => `${entry.name}: ${entry.reason ?? 'Skipped'}`)
              .join(' | ')
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
          [folder.id]: { phase, progress: 100, message, detail: rejectedDetail }
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
    [
      clearFolderUploadHideTimer,
      onUploadComplete,
      refreshFolders,
      scheduleFolderUploadHide,
      uploadFolderFilesMutation
    ]
  );

  const onFolderUploadInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const folderId = pendingUploadFolderIdRef.current;
      pendingUploadFolderIdRef.current = null;
      const files = Array.from(event.target.files ?? []);
      event.target.value = '';
      if (!folderId || files.length === 0) return;
      const folder = folderMap.get(folderId);
      if (!folder) return;
      await uploadFilesToFolder(folder, files);
    },
    [folderMap, uploadFilesToFolder]
  );

  const openFolderUploadPicker = useCallback(
    (folderId: string) => {
      const uploadState = folderUploads[folderId];
      if (
        folderActionState.loading ||
        uploadState?.phase === 'uploading' ||
        uploadState?.phase === 'processing'
      )
        return;
      pendingUploadFolderIdRef.current = folderId;
      const input = uploadInputRef.current;
      if (!input) return;
      input.value = '';
      input.click();
    },
    [folderActionState.loading, folderUploads]
  );

  const onDeleteFolder = useCallback(
    async (folder: Folder) => {
      const confirmed = await confirm(
        `Remove "${folder.path}" from the watch list?`,
        { title: 'Remove folder', confirmLabel: 'Remove', destructive: true }
      );
      if (!confirmed) return;
      setFolderActionState({ loading: true, error: null });
      try {
        await deleteFolderMutation.mutateAsync(folder.id);
        setFolderActionState({ loading: false, error: null });
      } catch (err) {
        setFolderActionState({ loading: false, error: (err as Error).message });
      }
    },
    [deleteFolderMutation, confirm]
  );

  // ----- Effects -----

  // Unmount: clear all upload-hide timers.
  useEffect(() => {
    return () => {
      Object.values(folderUploadHideTimersRef.current).forEach((timer) =>
        window.clearTimeout(timer)
      );
      folderUploadHideTimersRef.current = {};
    };
  }, []);

  // Scan-status polling: start 5s interval when any folder is SCANNING; stop
  // when none are. Cleanup on unmount.
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

  // Scan-finished notification: fires onScanFinished once when all folders
  // leave SCANNING state (transition from scanning → done).
  useEffect(() => {
    const anyScanning = folders.some((folder) => folder.status === 'SCANNING');
    if (lastScanActiveRef.current && !anyScanning) {
      lastScanActiveRef.current = false;
      onScanFinished?.();
    } else if (anyScanning) {
      lastScanActiveRef.current = true;
    }
  }, [folders, onScanFinished]);

  // ----- Assemble panelProps -----

  const panelProps: FoldersListPanelProps = {
    orderedFolders,
    folderDetailsById,
    folderUploads,
    folderActionState,
    favoritesSettings,
    favoritesSettingsState,
    libraryRoot,
    uploadInputAccept,
    uploadInputRef,
    onFolderUploadInputChange,
    onOpenFolderUploadPicker: openFolderUploadPicker,
    onUpdateFavoritesRoot,
    onDeleteFolder,
    describeFolder
  };

  return {
    folders,
    orderedFolders,
    folderDetailsById,
    panelProps,
    refreshFolders
  };
}
