import { useEffect, useMemo, useRef } from 'react';

import type { DeviceProfile } from '@/api';
import { useFolders } from '@/hooks/folders';

// The core rescans the library folder every minute and moves `lastScanAt` only when it found a
// change, so a new file shows within about a minute and a half.
const FOLDER_POLL_INTERVAL_MS = 30_000;

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
  const lastScanRef = useRef<string | null>(null);
  const rootFolderId = useMemo(() => {
    const root = normalizeComparablePath(libraryRoot);
    return folders.find((folder) => normalizeComparablePath(folder.path) === root)?.id ?? null;
  }, [folders, libraryRoot]);

  useEffect(() => {
    if (!foldersQuery.data) return;
    const revision = JSON.stringify(folders.map((folder) => [folder.id, folder.lastScanAt]).sort());
    const changed = lastScanRef.current !== null && lastScanRef.current !== revision;
    lastScanRef.current = revision;
    if (changed) onScanFinished?.();
  }, [folders, foldersQuery.data, onScanFinished]);

  return { rootFolderId };
}
