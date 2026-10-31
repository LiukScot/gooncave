import type { DuplicateScanOptions } from '@/api';

export const queryKeys = {
  device: ['device'] as const,
  tagDatabase: ['tag-database'] as const,
  originals: ['originals'] as const,
  folders: {
    all: ['folders'] as const,
    list: () => [...queryKeys.folders.all, 'list'] as const
  },
  files: {
    all: ['files'] as const,
    providers: (fileId: string) =>
      [...queryKeys.files.all, fileId, 'providers'] as const,
    tags: (fileId: string) => [...queryKeys.files.all, fileId, 'tags'] as const,
    sourceText: (fileId: string) =>
      [...queryKeys.files.all, fileId, 'source-text'] as const,
    comments: (fileId: string) =>
      [...queryKeys.files.all, fileId, 'comments'] as const
  },
  explorePostText: (siteId: string, remoteId: string) =>
    ['explore', 'post-text', siteId, remoteId] as const,
  explorePostComments: (siteId: string, remoteId: string) =>
    ['explore', 'post-comments', siteId, remoteId] as const,
  sources: {
    all: ['sources'] as const,
    list: () => [...queryKeys.sources.all, 'list'] as const
  },
  trash: {
    all: ['trash'] as const,
    settings: () => [...queryKeys.trash.all, 'settings'] as const,
    files: () => [...queryKeys.trash.all, 'files'] as const
  },
  favorites: {
    all: ['favorites'] as const,
    syncStatus: () => [...queryKeys.favorites.all, 'sync-status'] as const
  },
  credentials: {
    all: ['credentials'] as const,
    list: () => [...queryKeys.credentials.all, 'list'] as const
  },
  duplicates: {
    all: ['duplicates'] as const,
    scanStatus: () => [...queryKeys.duplicates.all, 'scan-status'] as const,
    policyStatus: () => [...queryKeys.duplicates.all, 'policy-status'] as const,
    settings: () => [...queryKeys.duplicates.all, 'settings'] as const,
    libraryRepair: () => [...queryKeys.duplicates.all, 'library-repair'] as const,
    scan: (options?: DuplicateScanOptions) =>
      [...queryKeys.duplicates.all, 'scan', options ?? {}] as const
  },
  settings: {
    all: ['settings'] as const,
    extra: () => [...queryKeys.settings.all, 'extra'] as const,
    shortcuts: () => [...queryKeys.settings.all, 'shortcuts'] as const,
    blacklist: () => [...queryKeys.settings.all, 'blacklist'] as const,
    subscriptions: () => [...queryKeys.settings.all, 'subscriptions'] as const,
    subscriptionTags: () =>
      [...queryKeys.settings.all, 'subscription-tags'] as const,
    subscriptionPools: () =>
      [...queryKeys.settings.all, 'subscription-pools'] as const
  },
  booruSites: {
    all: ['booru-sites'] as const,
    list: () => [...queryKeys.booruSites.all, 'list'] as const,
    engineCatalog: () =>
      [...queryKeys.booruSites.all, 'engine-catalog'] as const,
    tagRefresh: () => [...queryKeys.booruSites.all, 'tag-refresh'] as const
  }
} as const;
