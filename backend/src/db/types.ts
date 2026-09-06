import type { MediaKind } from '../lib/scanner';

export type FolderStatus = 'IDLE' | 'SCANNING';
export type ScanStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export type FolderType = 'LOCAL' | 'WEBDAV';

export type FolderRecord = {
  id: string;
  userId: string | null;
  path: string;
  type: FolderType;
  createdAt: string;
  updatedAt: string;
  lastScanAt: string | null;
  status: FolderStatus;
};

export type ScanRecord = {
  id: string;
  folderId: string;
  status: ScanStatus;
  progress: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FileRecord = {
  id: string;
  folderId: string;
  locationType: FolderType;
  path: string;
  sizeBytes: number;
  mtime: string;
  sha256: string;
  phash: string | null;
  mediaType: MediaKind;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbPath: string | null;
  voteScore?: number;
  /** ISO timestamp of the next allowed vote, null when never voted. */
  nextVoteAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderRunRecord = {
  id: string;
  fileId: string;
  provider: 'SAUCENAO' | 'FLUFFLE';
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  cachedHit: boolean;
  score: number | null;
  sourceUrl: string | null;
  thumbUrl: string | null;
  results?: {
    sourceUrl: string | null;
    score: number | null;
    distance?: number | null;
    sourceName: string | null;
    thumbUrl: string | null;
  }[];
  createdAt: string;
  completedAt: string | null;
  error: string | null;
};

/** One file's place in a booru's parent/child group, as last read. */
export type FilePostRelationRecord = {
  fileId: string;
  /** Same key file_tags uses: a preset key or a user_booru_sites id. */
  source: string;
  remoteId: string;
  parentId: string | null;
  hasChildren: boolean;
  /** Null when the booru's listing never says which pools a post is in. */
  poolIds: string[] | null;
  updatedAt: string;
};

export type FavoriteProvider = string;

export type FavoriteItemRecord = {
  provider: FavoriteProvider;
  remoteId: string;
  filePath: string;
  sourceUrl: string | null;
  fileUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CredentialProvider = 'E621' | 'DANBOORU' | 'SAUCENAO';

export type BooruEngineType =
  | 'danbooru'
  | 'e621'
  | 'moebooru'
  | 'gelbooru'
  | 'sankaku'
  | 'philomena'
  | 'shimmie'
  | 'szurubooru';

export type BooruSiteRecord = {
  id: string;
  userId: string;
  name: string;
  engine: BooruEngineType;
  baseUrl: string;
  username: string | null;
  apiKey: string | null;
  sessionCookie: string | null;
  isPreset: boolean;
  presetKey: string | null;
  enabled: boolean;
  siteAutoSyncMidnight: boolean;
  siteReverseSyncEnabled: boolean;
  siteAutoFavEnabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type BooruSiteInput = {
  name: string;
  engine: BooruEngineType;
  baseUrl: string;
  username?: string | null;
  apiKey?: string | null;
  sessionCookie?: string | null;
  isPreset?: boolean;
  presetKey?: string | null;
  enabled?: boolean;
  siteAutoSyncMidnight?: boolean;
  siteReverseSyncEnabled?: boolean;
  siteAutoFavEnabled?: boolean;
  sortOrder?: number;
};

export type CredentialRecord = {
  provider: CredentialProvider;
  username: string | null;
  apiKey: string | null;
  updatedAt: string;
};

export type FavoritesSettings = {
  favoritesRootId: string | null;
};

export type DuplicateSettings = {
  autoResolve: boolean;
};

export type UserRecord = {
  id: string;
  username: string;
  passwordHash: string;
  libraryRoot: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

export type SessionRecord = {
  id: string;
  userId: string;
  token: string;
  createdAt: string;
  expiresAt: string;
};

export type TagSource = string;

export const SPECIAL_TAG_SOURCES = ['WD14', 'MANUAL'] as const;
export const LEGACY_BOORU_TAG_SOURCES = [
  'E621',
  'DANBOORU',
  'GELBOORU',
  'YANDERE',
  'KONACHAN',
  'SANKAKU',
  'IDOL_COMPLEX'
] as const;

export type FileTagRecord = {
  fileId: string;
  tag: string;
  /** The tag this one collapses to once aliases are applied. */
  canonicalTag: string;
  category: string;
  source: TagSource;
  score: number | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
};
