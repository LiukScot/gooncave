import { useEffect, useMemo, useRef } from 'react';

import type { DeviceProfile } from '@/api';
import { useFolders } from '@/hooks/folders';

const FOLDER_POLL_INTERVAL_MS = 5000;

const normalizeComparablePath = (value: string): string => {
  if (!value) return '/';
  const normalized = value.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FoldersControllerInput = {
  authUser: DeviceProfile | null;
  libraryRoot: string;
  onScanFinished?: () => void;
};

export function useFoldersController({ authUser, libraryRoot, onScanFinished }: FoldersControllerInput) {
  const foldersQuery = useFolders({
    enabled: Boolean(authUser),
    refetchInterval: FOLDER_POLL_INTERVAL_MS
  });
  const folders = useMemo(() => foldersQuery.data ?? [], [foldersQuery.data]);
  const lastScanActiveRef = useRef(false);
  const lastCompletedScanRef = useRef<string | null>(null);
  const rootFolderId = useMemo(() => {
    const root = normalizeComparablePath(libraryRoot);
    return folders.find((folder) => normalizeComparablePath(folder.path) === root)?.id ?? null;
  }, [folders, libraryRoot]);

  useEffect(() => {
    if (!foldersQuery.data) return;
    const anyScanning = folders.some((folder) => folder.status === 'SCANNING');
    const revision = JSON.stringify(folders.map((folder) => [folder.id, folder.lastScanAt]).sort());
    const changed = lastCompletedScanRef.current !== null && lastCompletedScanRef.current !== revision;
    if (!anyScanning) lastCompletedScanRef.current = revision;
    if (anyScanning) {
      lastScanActiveRef.current = true;
    } else if (lastScanActiveRef.current || changed) {
      lastScanActiveRef.current = false;
      onScanFinished?.();
    }
  }, [folders, foldersQuery.data, onScanFinished]);

  return { rootFolderId };
}
