import { useMemo } from 'react';

import type { DeviceProfile } from '@/api';
import { useFolders } from '@/hooks/folders';

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
};

export function useFoldersController({ authUser, libraryRoot }: FoldersControllerInput) {
  const foldersQuery = useFolders({ enabled: Boolean(authUser) });
  const folders = useMemo(() => foldersQuery.data ?? [], [foldersQuery.data]);
  const rootFolderId = useMemo(() => {
    const root = normalizeComparablePath(libraryRoot);
    return folders.find((folder) => normalizeComparablePath(folder.path) === root)?.id ?? null;
  }, [folders, libraryRoot]);

  return { rootFolderId };
}
