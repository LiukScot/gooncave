import { sqlite } from '../client';

export type ExtraSettings = {
  gamesTabEnabled: boolean;
  voteSystemEnabled: boolean;
  autoVoteOnFavorite: boolean;
};

const EXTRA_DEFAULTS: ExtraSettings = {
  gamesTabEnabled: true,
  voteSystemEnabled: true,
  autoVoteOnFavorite: true
};

const settingKeys: Record<keyof ExtraSettings, string> = {
  gamesTabEnabled: 'extra.gamesTabEnabled',
  voteSystemEnabled: 'extra.voteSystemEnabled',
  autoVoteOnFavorite: 'extra.autoVoteOnFavorite'
};

const readBool = (userId: string, key: string, fallback: boolean) => {
  const row = sqlite
    .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
    .get(userId, key) as { value: string } | undefined;
  if (!row) return fallback;
  return row.value === 'true';
};

const writeBool = (userId: string, key: string, value: boolean) => {
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)'
    )
    .run(userId, key, value ? 'true' : 'false');
};

export const getExtraSettings = (userId: string): ExtraSettings => ({
  gamesTabEnabled: readBool(
    userId,
    settingKeys.gamesTabEnabled,
    EXTRA_DEFAULTS.gamesTabEnabled
  ),
  voteSystemEnabled: readBool(
    userId,
    settingKeys.voteSystemEnabled,
    EXTRA_DEFAULTS.voteSystemEnabled
  ),
  autoVoteOnFavorite: readBool(
    userId,
    settingKeys.autoVoteOnFavorite,
    EXTRA_DEFAULTS.autoVoteOnFavorite
  )
});

/** Applies only the keys present in `patch`; returns the full settled state. */
export const saveExtraSettings = (
  patch: Partial<ExtraSettings>,
  userId: string
): ExtraSettings => {
  for (const key of Object.keys(settingKeys) as (keyof ExtraSettings)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    writeBool(userId, settingKeys[key], value);
  }
  return getExtraSettings(userId);
};

const SHORTCUTS_KEY = 'shortcuts.bindings';

/**
 * Key bindings, stored as one JSON blob. The server keeps no list of valid
 * actions: the client owns which actions exist, and it re-checks every entry
 * on read, so a binding added by a newer build is preserved rather than
 * dropped by an older server.
 */
export const getShortcuts = (userId: string): Record<string, string> => {
  const row = sqlite
    .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
    .get(userId, SHORTCUTS_KEY) as { value: string } | undefined;
  if (!row) return {};
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
  } catch {
    // A row hand-edited into invalid JSON must not lock the user out of
    // their own shortcuts; the client falls back to the defaults.
    return {};
  }
};

export const saveShortcuts = (
  userId: string,
  bindings: Record<string, string>
): Record<string, string> => {
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)'
    )
    .run(userId, SHORTCUTS_KEY, JSON.stringify(bindings));
  return getShortcuts(userId);
};

const BLACKLIST_KEY = 'blacklist.settings';

export type BlacklistSettings = {
  /** Normalised tags; a file or post carrying any of them is hidden. */
  tags: string[];
  applyToExplore: boolean;
  applyToGallery: boolean;
};

const BLACKLIST_DEFAULTS: BlacklistSettings = {
  tags: [],
  applyToExplore: true,
  applyToGallery: false
};

/**
 * The blacklist, stored as one JSON blob. A row that cannot be read falls
 * back to the defaults: an unreadable blacklist must not blank the page or
 * hide everything.
 */
export const getBlacklist = (userId: string): BlacklistSettings => {
  const row = sqlite
    .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
    .get(userId, BLACKLIST_KEY) as { value: string } | undefined;
  if (!row) return { ...BLACKLIST_DEFAULTS };
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...BLACKLIST_DEFAULTS };
    }
    const value = parsed as Partial<Record<keyof BlacklistSettings, unknown>>;
    return {
      tags: Array.isArray(value.tags)
        ? value.tags.filter((tag): tag is string => typeof tag === 'string')
        : BLACKLIST_DEFAULTS.tags,
      applyToExplore:
        typeof value.applyToExplore === 'boolean'
          ? value.applyToExplore
          : BLACKLIST_DEFAULTS.applyToExplore,
      applyToGallery:
        typeof value.applyToGallery === 'boolean'
          ? value.applyToGallery
          : BLACKLIST_DEFAULTS.applyToGallery
    };
  } catch {
    return { ...BLACKLIST_DEFAULTS };
  }
};

/** Applies only the keys present in `patch`; returns the full settled state. */
export const saveBlacklist = (
  patch: Partial<BlacklistSettings>,
  userId: string
): BlacklistSettings => {
  const next: BlacklistSettings = { ...getBlacklist(userId), ...patch };
  sqlite
    .prepare(
      'INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)'
    )
    .run(userId, BLACKLIST_KEY, JSON.stringify(next));
  return next;
};

export const settingsRepo = {
  getExtraSettings,
  saveExtraSettings,
  getShortcuts,
  saveShortcuts,
  getBlacklist,
  saveBlacklist
};
