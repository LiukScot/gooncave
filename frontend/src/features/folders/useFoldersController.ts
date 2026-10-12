import { useEffect, useMemo, useRef } from 'react';

import type { DeviceProfile, Folder } from '@/api';
import { useFolders } from '@/hooks/folders';
import { basenameFromPath } from '@/lib/format';

const FOLDER_POLL_INTERVAL_MS = 5000;

export type FolderDescriptor = { isRoot: boolean; filterLabel: string };

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
  if (relativePath === '') {
    return {
      isRoot: true,
      filterLabel: 'Main library'
    };
  }
  const title = basenameFromPath(relativePath || folder.path) || folder.path;
  return {
    isRoot: false,
    filterLabel: relativePath || title
  };
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
  const folderDetailsById = useMemo(() => new Map(
    folders.map((folder) => [folder.id, describeFolder(folder, libraryRoot)])
  ), [folders, libraryRoot]);
  const orderedFolders = useMemo(() => [...folders].sort((left, right) => {
    const leftInfo = folderDetailsById.get(left.id);
    const rightInfo = folderDetailsById.get(right.id);
    if (leftInfo?.isRoot !== rightInfo?.isRoot) return leftInfo?.isRoot ? -1 : 1;
    return (leftInfo?.filterLabel ?? left.path).localeCompare(rightInfo?.filterLabel ?? right.path);
  }), [folders, folderDetailsById]);

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

  return { folders, orderedFolders, folderDetailsById };
}
