import { authRepo } from '../db/repos/authRepo';
import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { favoritesRepo } from '../db/repos/favoritesRepo';

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
  backfilledKeys: number;
}> => {
  const [scannedUsers, missingPresetCredentials] = await Promise.all([
    authRepo.countUsers(),
    authRepo.listLegacyBooruCredentialsMissingSites(['E621', 'DANBOORU'])
  ]);
  let inserted = 0;
  for (const credential of missingPresetCredentials) {
    if (!PRESETS_WITH_LEGACY_CREDS.has(credential.provider)) continue;
    const preset = BOORU_PRESETS.find((p) => p.key === credential.provider);
    if (!preset) continue;
    const siteDefaults = await favoritesRepo.getLegacyPerSiteFavoritesDefaults(
      credential.userId
    );
    await booruSitesRepo.insertBooruSite(
      {
        name: preset.name,
        engine: preset.engine,
        baseUrl: preset.baseUrl,
        username: credential.username,
        apiKey: credential.apiKey,
        isPreset: true,
        presetKey: preset.key,
        enabled: true,
        siteAutoSyncMidnight: siteDefaults.siteAutoSyncMidnight,
        siteReverseSyncEnabled: siteDefaults.siteReverseSyncEnabled,
        siteAutoFavEnabled: siteDefaults.siteAutoFavEnabled
      },
      credential.userId
    );
    inserted += 1;
  }
  // Rows that already existed were skipped above, so a key sitting in
  // provider_credentials for one of them never reached the site it belongs
  // to. Fill those in: the account looks configured either way, and without
  // the key every authenticated call (vote, favorite, sync) is refused.
  const stranded = await authRepo.listLegacyBooruKeysForSitesMissingKey([
    'E621',
    'DANBOORU'
  ]);
  let backfilled = 0;
  for (const credential of stranded) {
    await booruSitesRepo.updateBooruSite(
      credential.siteId,
      {
        apiKey: credential.apiKey,
        ...(credential.username ? { username: credential.username } : {})
      },
      credential.userId
    );
    backfilled += 1;
  }

  return { scannedUsers, insertedRows: inserted, backfilledKeys: backfilled };
};
