import { dataStore } from './dataStore';
import { BOORU_PRESETS } from './booruEngines/presets';

const PRESETS_WITH_LEGACY_CREDS = new Set(['E621', 'DANBOORU']);

/**
 * One-shot, idempotent migration. For each user that has stored credentials in
 * provider_credentials for E621 / DANBOORU, ensure a matching preset row in
 * user_booru_sites exists with the credentials copied over. Users without
 * credentials are left empty: they'll add sites via the UI on demand.
 *
 * Safe to call on every boot — does nothing if a preset row already exists for
 * the user.
 */
export const seedBooruSitesFromLegacyCredentials = async (): Promise<{
  scannedUsers: number;
  insertedRows: number;
}> => {
  const users = await dataStore.listUsers();
  let inserted = 0;
  for (const user of users) {
    const credentials = await dataStore.listCredentials(user.id);
    for (const credential of credentials) {
      if (!PRESETS_WITH_LEGACY_CREDS.has(credential.provider)) continue;
      const preset = BOORU_PRESETS.find((p) => p.key === credential.provider);
      if (!preset) continue;
      const existing = await dataStore.findBooruSiteByPresetKey(preset.key, user.id);
      if (existing) continue;
      await dataStore.insertBooruSite(
        {
          name: preset.name,
          engine: preset.engine,
          baseUrl: preset.baseUrl,
          username: credential.username,
          apiKey: credential.apiKey,
          isPreset: true,
          presetKey: preset.key,
          enabled: true,
          capFavorites: preset.defaultCapabilities.favorites,
          capTags: preset.defaultCapabilities.tags,
          capSourceMatch: preset.defaultCapabilities.sourceMatch,
          capSearch: preset.defaultCapabilities.search
        },
        user.id
      );
      inserted += 1;
    }
  }
  return { scannedUsers: users.length, insertedRows: inserted };
};
