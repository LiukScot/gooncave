import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex
} from 'drizzle-orm/sqlite-core';

export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
});

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    libraryRoot: text('library_root').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastLoginAt: text('last_login_at')
  },
  (table) => ({
    usernameIdx: index('idx_users_username').on(table.username),
    usernameLowerIdx: index('idx_users_username_lower').on(table.username)
  })
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull()
  },
  (table) => ({
    tokenUnique: uniqueIndex('sessions_token_unique').on(table.token),
    userIdx: index('idx_sessions_user_id').on(table.userId),
    tokenIdx: index('idx_sessions_token').on(table.token),
    expiresIdx: index('idx_sessions_expires_at').on(table.expiresAt)
  })
);

export const userSettings = sqliteTable(
  'user_settings',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.key] }),
    userKeyIdx: index('idx_user_settings_user_key').on(table.userId, table.key)
  })
);

export const folders = sqliteTable(
  'folders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id'),
    path: text('path').notNull(),
    type: text('type').notNull(),
    webdavUrl: text('webdav_url'),
    webdavUsername: text('webdav_username'),
    webdavPassword: text('webdav_password'),
    remotePath: text('remote_path'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastScanAt: text('last_scan_at'),
    status: text('status').notNull()
  },
  (table) => ({
    pathIdx: index('idx_folders_path').on(table.path),
    userIdx: index('idx_folders_user_id').on(table.userId)
  })
);

export const scans = sqliteTable(
  'scans',
  {
    id: text('id').primaryKey(),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    progress: real('progress').notNull(),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => ({
    folderIdx: index('idx_scans_folder_id').on(table.folderId)
  })
);

export const files = sqliteTable(
  'files',
  {
    id: text('id').primaryKey(),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    locationType: text('location_type').notNull(),
    path: text('path').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    mtime: text('mtime').notNull(),
    sha256: text('sha256').notNull(),
    phash: text('phash'),
    mediaType: text('media_type').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    thumbPath: text('thumb_path'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => ({
    folderIdx: index('idx_files_folder_id').on(table.folderId),
    pathIdx: index('idx_files_path').on(table.path),
    createdIdx: index('idx_files_created_at_id').on(table.createdAt, table.id),
    mtimeIdx: index('idx_files_mtime_id').on(table.mtime, table.id),
    mediaIdx: index('idx_files_media_type').on(table.mediaType)
  })
);

export const providerRuns = sqliteTable(
  'provider_runs',
  {
    id: text('id').primaryKey(),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    status: text('status').notNull(),
    cachedHit: integer('cached_hit').notNull(),
    score: real('score'),
    sourceUrl: text('source_url'),
    thumbUrl: text('thumb_url'),
    results: text('results'),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
    error: text('error')
  },
  (table) => ({
    fileIdx: index('idx_provider_runs_file_id').on(table.fileId),
    fileProviderCreatedIdx: index('idx_provider_runs_file_provider_created').on(
      table.fileId,
      table.provider,
      table.completedAt,
      table.createdAt
    ),
    providerFileIdx: index('idx_provider_runs_provider_file_id').on(
      table.provider,
      table.fileId
    ),
    providerCreatedHitIdx: index('idx_provider_runs_provider_created_hit').on(
      table.provider,
      table.createdAt,
      table.cachedHit
    )
  })
);

export const fileTags = sqliteTable(
  'file_tags',
  {
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    category: text('category').notNull(),
    source: text('source').notNull(),
    score: real('score'),
    sourceUrl: text('source_url'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.fileId, table.tag, table.source] }),
    fileIdx: index('idx_file_tags_file_id').on(table.fileId),
    tagIdx: index('idx_file_tags_tag').on(table.tag),
    tagFileIdx: index('idx_file_tags_tag_file_id').on(table.tag, table.fileId)
  })
);

export const fileFavorites = sqliteTable(
  'file_favorites',
  {
    fileId: text('file_id')
      .primaryKey()
      .references(() => files.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull()
  },
  (table) => ({
    fileIdx: index('idx_file_favorites_file_id').on(table.fileId),
    createdIdx: index('idx_file_favorites_created_at').on(table.createdAt)
  })
);

export const favoriteItems = sqliteTable(
  'favorite_items',
  {
    userId: text('user_id'),
    provider: text('provider').notNull(),
    remoteId: text('remote_id').notNull(),
    filePath: text('file_path').notNull(),
    sourceUrl: text('source_url'),
    fileUrl: text('file_url'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.provider, table.remoteId] }),
    userProviderIdx: index('idx_favorite_items_user_id_provider').on(
      table.userId,
      table.provider
    ),
    providerIdx: index('idx_favorite_items_provider').on(table.provider),
    filePathIdx: index('idx_favorite_items_file_path').on(table.filePath)
  })
);

export const providerCredentials = sqliteTable(
  'provider_credentials',
  {
    userId: text('user_id'),
    provider: text('provider').notNull(),
    username: text('username'),
    apiKey: text('api_key'),
    updatedAt: text('updated_at').notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.provider] }),
    providerIdx: index('idx_provider_credentials_provider').on(table.provider)
  })
);

export const userBooruSites = sqliteTable(
  'user_booru_sites',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    engine: text('engine').notNull(),
    baseUrl: text('base_url').notNull(),
    username: text('username'),
    apiKey: text('api_key'),
    isPreset: integer('is_preset').notNull(),
    presetKey: text('preset_key'),
    enabled: integer('enabled').notNull(),
    siteAutoSyncMidnight: integer('site_auto_sync_midnight').notNull(),
    siteReverseSyncEnabled: integer('site_reverse_sync_enabled').notNull(),
    siteAutoFavEnabled: integer('site_auto_fav_enabled').notNull(),
    sortOrder: integer('sort_order').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => ({
    userSortIdx: index('idx_user_booru_sites_user_sort').on(
      table.userId,
      table.sortOrder
    ),
    userPresetUnique: uniqueIndex('user_booru_sites_user_preset_unique').on(
      table.userId,
      table.presetKey
    ),
    userBaseUrlUnique: uniqueIndex('user_booru_sites_user_base_url_unique').on(
      table.userId,
      table.baseUrl
    )
  })
);

export const fileManualOrder = sqliteTable(
  'file_manual_order',
  {
    fileId: text('file_id')
      .primaryKey()
      .references(() => files.id, { onDelete: 'cascade' }),
    position: real('position').notNull(),
    updatedAt: text('updated_at').notNull()
  },
  (table) => ({
    positionIdx: index('idx_file_manual_order_position').on(table.position)
  })
);

export const fileSignatures = sqliteTable(
  'file_signatures',
  {
    fileId: text('file_id')
      .primaryKey()
      .references(() => files.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    sampleSize: integer('sample_size').notNull(),
    data: blob('data', { mode: 'buffer' }).notNull(),
    sourceHash: text('source_hash').notNull(),
    createdAt: text('created_at').notNull()
  },
  (table) => ({
    sampleSizeIdx: index('idx_file_signatures_sample_size_file_id').on(
      table.sampleSize,
      table.fileId
    )
  })
);
