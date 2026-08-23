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

export const settingsRepo = { getExtraSettings, saveExtraSettings };
