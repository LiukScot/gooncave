import { sqlite } from '../client';

export type ExtraSettings = {
  gamesTabEnabled: boolean;
  voteSystemEnabled: boolean;
};

const EXTRA_DEFAULTS: ExtraSettings = {
  gamesTabEnabled: true,
  voteSystemEnabled: true
};

const settingKeys: Record<keyof ExtraSettings, string> = {
  gamesTabEnabled: 'extra.gamesTabEnabled',
  voteSystemEnabled: 'extra.voteSystemEnabled'
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

export const settingsRepo = {
  getExtraSettings,
  saveExtraSettings,
  getShortcuts,
  saveShortcuts
};
