import type { DuplicateScanOptions } from '@/api';

export const queryKeys = {
  auth: {
    all: ['auth'] as const,
    me: () => [...queryKeys.auth.all, 'me'] as const
  },
  folders: {
    all: ['folders'] as const,
    list: () => [...queryKeys.folders.all, 'list'] as const
  },
  files: {
    all: ['files'] as const,
    list: (params: {
      folderId?: string;
      sort?: string;
      tags?: string;
      mediaType?: string;
      seed?: string;
      offset?: number;
      limit?: number;
    }) => [...queryKeys.files.all, 'list', params] as const,
    providers: (fileId: string) =>
      [...queryKeys.files.all, fileId, 'providers'] as const,
    tags: (fileId: string) => [...queryKeys.files.all, fileId, 'tags'] as const
  },
  tagDb: {
    all: ['tag-db'] as const,
    status: () => [...queryKeys.tagDb.all, 'status'] as const,
    aliases: () => [...queryKeys.tagDb.all, 'aliases'] as const
  },
  sauces: {
    all: ['sauces'] as const,
    list: () => [...queryKeys.sauces.all, 'list'] as const
  },
  favorites: {
    all: ['favorites'] as const,
    syncStatus: () => [...queryKeys.favorites.all, 'sync-status'] as const,
    settings: () => [...queryKeys.favorites.all, 'settings'] as const
  },
  credentials: {
    all: ['credentials'] as const,
    list: () => [...queryKeys.credentials.all, 'list'] as const
  },
  duplicates: {
    all: ['duplicates'] as const,
    scanStatus: () => [...queryKeys.duplicates.all, 'scan-status'] as const,
    settings: () => [...queryKeys.duplicates.all, 'settings'] as const,
    scan: (options?: DuplicateScanOptions) =>
      [...queryKeys.duplicates.all, 'scan', options ?? {}] as const
  },
  settings: {
    all: ['settings'] as const,
    extra: () => [...queryKeys.settings.all, 'extra'] as const,
    shortcuts: () => [...queryKeys.settings.all, 'shortcuts'] as const,
    blacklist: () => [...queryKeys.settings.all, 'blacklist'] as const
  },
  booruSites: {
    all: ['booru-sites'] as const,
    list: () => [...queryKeys.booruSites.all, 'list'] as const,
    engineCatalog: () =>
      [...queryKeys.booruSites.all, 'engine-catalog'] as const
  }
} as const;
