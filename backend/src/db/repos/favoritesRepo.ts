import { config } from '../../config';
import type {
  DuplicateSettings,
  FavoriteItemRecord,
  FavoriteProvider,
  FavoritesSettings
} from '../../db/types';
import { sqlite } from '../client';

type FavoriteItemRow = {
  provider: FavoriteProvider;
  remote_id: string;
  file_path: string;
  source_url?: string | null;
  file_url?: string | null;
  created_at: string;
  updated_at: string;
};

const mapFavoriteRow = (row: FavoriteItemRow): FavoriteItemRecord => ({
  provider: row.provider,
  remoteId: row.remote_id,
  filePath: row.file_path,
  sourceUrl: row.source_url ?? null,
  fileUrl: row.file_url ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const getUserSetting = (userId: string, key: string) => {
  const row = sqlite
    .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
    .get(userId, key) as { value: string } | undefined;
  return row?.value ?? null;
};

const setUserSetting = (userId: string, key: string, value: string) => {
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)'
    )
    .run(userId, key, value);
};

const deleteUserSetting = (userId: string, key: string) => {
  sqlite
    .prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?')
    .run(userId, key);
};

const readUserSettingJson = <T>(
  userId: string,
  key: string,
  fallback: T
): T => {
  const raw = getUserSetting(userId, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error('[favorites] failed to parse user setting json', {
      userId,
      key,
      raw,
      error
    });
    throw error;
  }
};

const readUserSettingBool = (
  userId: string,
  key: string,
  fallback: boolean
) => {
  const raw = getUserSetting(userId, key);
  if (raw === null) return fallback;
  return raw === 'true';
};

const readUserSettingString = (userId: string, key: string) => {
  const raw = getUserSetting(userId, key);
  if (!raw) return null;
  const cleaned = raw.trim();
  return cleaned.length > 0 ? cleaned : null;
};

const writeUserSettingJson = (userId: string, key: string, value: unknown) => {
  setUserSetting(userId, key, JSON.stringify(value));
};

const normalizeKeyList = (value: string[] | undefined) => {
  if (!Array.isArray(value)) return [];
  const cleaned = value
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(cleaned));
};

export const favoritesRepo = {
  async listFavoriteItems(
    provider: FavoriteProvider | undefined,
    userId: string
  ) {
    const rows = provider
      ? (sqlite
          .prepare(
            'SELECT * FROM favorite_items WHERE provider = ? AND user_id = ? ORDER BY updated_at DESC'
          )
          .all(provider, userId) as FavoriteItemRow[])
      : (sqlite
          .prepare(
            'SELECT * FROM favorite_items WHERE user_id = ? ORDER BY updated_at DESC'
          )
          .all(userId) as FavoriteItemRow[]);
    return rows.map(mapFavoriteRow);
  },
  async listFavoriteItemsByPath(filePath: string, userId: string) {
    const rows = sqlite
      .prepare(
        'SELECT * FROM favorite_items WHERE file_path = ? AND user_id = ? ORDER BY updated_at DESC'
      )
      .all(filePath, userId) as FavoriteItemRow[];
    return rows.map(mapFavoriteRow);
  },
  async upsertFavoriteItem(
    item: {
      provider: FavoriteProvider;
      remoteId: string;
      filePath: string;
      sourceUrl?: string | null;
      fileUrl?: string | null;
    },
    userId: string
  ) {
    const now = new Date().toISOString();
    const existing = sqlite
      .prepare(
        'SELECT * FROM favorite_items WHERE provider = ? AND remote_id = ? AND user_id = ?'
      )
      .get(item.provider, item.remoteId, userId) as FavoriteItemRow | undefined;
    if (existing) {
      sqlite
        .prepare(
          `UPDATE favorite_items
         SET file_path = ?, source_url = ?, file_url = ?, updated_at = ?
         WHERE provider = ? AND remote_id = ? AND user_id = ?`
        )
        .run(
          item.filePath,
          item.sourceUrl ?? null,
          item.fileUrl ?? null,
          now,
          item.provider,
          item.remoteId,
          userId
        );
      return {
        ...mapFavoriteRow(existing),
        filePath: item.filePath,
        sourceUrl: item.sourceUrl ?? null,
        fileUrl: item.fileUrl ?? null,
        updatedAt: now
      };
    }
    sqlite
      .prepare(
        `INSERT INTO favorite_items (user_id, provider, remote_id, file_path, source_url, file_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        item.provider,
        item.remoteId,
        item.filePath,
        item.sourceUrl ?? null,
        item.fileUrl ?? null,
        now,
        now
      );
    return {
      provider: item.provider,
      remoteId: item.remoteId,
      filePath: item.filePath,
      sourceUrl: item.sourceUrl ?? null,
      fileUrl: item.fileUrl ?? null,
      createdAt: now,
      updatedAt: now
    } as FavoriteItemRecord;
  },
  async deleteFavoriteItem(
    provider: FavoriteProvider,
    remoteId: string,
    userId: string
  ) {
    sqlite
      .prepare(
        'DELETE FROM favorite_items WHERE provider = ? AND remote_id = ? AND user_id = ?'
      )
      .run(provider, remoteId, userId);
  },
  async getFavoritesSettings(userId: string): Promise<FavoritesSettings> {
    return {
      favoritesRootId: readUserSettingString(userId, 'favorites_root_id')
    };
  },
  async saveFavoritesSettings(
    input: Partial<FavoritesSettings>,
    userId: string
  ): Promise<FavoritesSettings> {
    const current = await this.getFavoritesSettings(userId);
    const favoritesRootId =
      input.favoritesRootId !== undefined
        ? input.favoritesRootId
        : current.favoritesRootId;
    if (favoritesRootId) {
      setUserSetting(userId, 'favorites_root_id', favoritesRootId);
    } else {
      deleteUserSetting(userId, 'favorites_root_id');
    }
    return { favoritesRootId: favoritesRootId ?? null };
  },
  async getLegacyPerSiteFavoritesDefaults(userId: string): Promise<{
    siteAutoSyncMidnight: boolean;
    siteReverseSyncEnabled: boolean;
    siteAutoFavEnabled: boolean;
  }> {
    const autoSyncDefault = config.favorites.syncIntervalMs > 0;
    return {
      siteAutoSyncMidnight: readUserSettingBool(
        userId,
        'favorites_auto_sync_midnight',
        autoSyncDefault
      ),
      siteReverseSyncEnabled: readUserSettingBool(
        userId,
        'favorites_reverse_sync',
        false
      ),
      siteAutoFavEnabled: readUserSettingBool(
        userId,
        'favorites_auto_fav',
        false
      )
    };
  },
  async getDuplicateSettings(userId: string): Promise<DuplicateSettings> {
    return {
      autoResolve: readUserSettingBool(userId, 'duplicates_auto_resolve', false)
    };
  },
  async saveDuplicateSettings(
    input: Partial<DuplicateSettings>,
    userId: string
  ): Promise<DuplicateSettings> {
    const current = await this.getDuplicateSettings(userId);
    const autoResolve =
      input.autoResolve !== undefined ? input.autoResolve : current.autoResolve;
    setUserSetting(
      userId,
      'duplicates_auto_resolve',
      autoResolve ? 'true' : 'false'
    );
    return { autoResolve };
  },
  async getSauceSettings(userId: string) {
    const display = readUserSettingJson<string[]>(userId, 'sauce_display', []);
    const targets = readUserSettingJson<string[]>(userId, 'sauce_targets', []);
    const displayInitialized = readUserSettingBool(
      userId,
      'sauce_display_initialized',
      display.length > 0
    );
    return { display, targets, displayInitialized };
  },
  async saveSauceSettings(
    input: {
      display?: string[];
      targets?: string[];
      displayInitialized?: boolean;
    },
    userId: string
  ) {
    const current = await this.getSauceSettings(userId);
    const display = normalizeKeyList(input.display ?? current.display);
    const targets = normalizeKeyList(input.targets ?? current.targets);
    const displayInitialized =
      input.displayInitialized ?? current.displayInitialized;
    writeUserSettingJson(userId, 'sauce_display', display);
    writeUserSettingJson(userId, 'sauce_targets', targets);
    setUserSetting(
      userId,
      'sauce_display_initialized',
      displayInitialized ? 'true' : 'false'
    );
    return { display, targets, displayInitialized };
  },
  async getSauceSettingsBatch(userIds: string[]) {
    if (userIds.length === 0)
      return new Map<
        string,
        Awaited<ReturnType<typeof this.getSauceSettings>>
      >();
    const placeholders = userIds.map(() => '?').join(',');
    const keys = [
      'sauce_display',
      'sauce_targets',
      'sauce_display_initialized'
    ];
    const keyPlaceholders = keys.map(() => '?').join(',');
    const rows = sqlite
      .prepare(
        `SELECT user_id, key, value FROM user_settings WHERE user_id IN (${placeholders}) AND key IN (${keyPlaceholders})`
      )
      .all(...userIds, ...keys) as {
      user_id: string;
      key: string;
      value: string;
    }[];
    const settingsByUser = new Map<string, Map<string, string>>();
    for (const row of rows) {
      if (!settingsByUser.has(row.user_id))
        settingsByUser.set(row.user_id, new Map());
      settingsByUser.get(row.user_id)!.set(row.key, row.value);
    }
    const result = new Map<
      string,
      { display: string[]; targets: string[]; displayInitialized: boolean }
    >();
    for (const userId of userIds) {
      const settings = settingsByUser.get(userId);
      const displayRaw = settings?.get('sauce_display');
      const targetsRaw = settings?.get('sauce_targets');
      const display = displayRaw ? (JSON.parse(displayRaw) as string[]) : [];
      const targets = targetsRaw ? (JSON.parse(targetsRaw) as string[]) : [];
      result.set(userId, {
        display,
        targets,
        displayInitialized: settings?.has('sauce_display_initialized')
          ? settings.get('sauce_display_initialized') === 'true'
          : display.length > 0
      });
    }
    return result;
  }
};
