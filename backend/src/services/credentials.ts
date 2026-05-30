import { authRepo } from '../db/repos/authRepo';
import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import type { CredentialProvider } from '../db/types';
import { BOORU_PRESETS } from '../lib/booruEngines/presets';

export type CredentialSource = 'db' | 'none';

export type ResolvedCredential = {
  provider: CredentialProvider;
  username: string | null;
  apiKey: string | null;
  source: CredentialSource;
  updatedAt: string | null;
};

const BOORU_PRESET_PROVIDERS = new Set<CredentialProvider>(['E621', 'DANBOORU']);

export const resolveCredential = async (provider: CredentialProvider, userId?: string): Promise<ResolvedCredential> => {
  if (!userId) {
    return { provider, username: null, apiKey: null, source: 'none', updatedAt: null };
  }
  // E621/DANBOORU credentials now live on user_booru_sites preset rows. Read
  // from there first; fall back to provider_credentials for legacy installs
  // where the seed migration hasn't been run yet.
  if (BOORU_PRESET_PROVIDERS.has(provider)) {
    const site = await booruSitesRepo.findBooruSiteByPresetKey(provider, userId);
    if (site?.username?.trim() && site.apiKey?.trim()) {
      return {
        provider,
        username: site.username,
        apiKey: site.apiKey,
        source: 'db',
        updatedAt: site.updatedAt
      };
    }
  }
  const stored = await authRepo.getCredential(provider, userId);
  if (stored) {
    return {
      provider,
      username: stored.username,
      apiKey: stored.apiKey,
      source: 'db',
      updatedAt: stored.updatedAt
    };
  }
  return { provider, username: null, apiKey: null, source: 'none', updatedAt: null };
};

export const resolveCredentials = async (providers: CredentialProvider[], userId?: string) => {
  const resolved = await Promise.all(providers.map((provider) => resolveCredential(provider, userId)));
  return resolved;
};

// Backward-compatible writer for `/credentials` PUT. For SAUCENAO this still
// hits provider_credentials; for E621/DANBOORU it updates the matching preset
// row in user_booru_sites (creating one if none exists yet).
export const upsertCredentialCompat = async (
  provider: CredentialProvider,
  updates: { username?: string; apiKey?: string },
  userId: string
): Promise<void> => {
  if (!BOORU_PRESET_PROVIDERS.has(provider)) {
    await authRepo.upsertCredential(provider, updates, userId);
    return;
  }
  const preset = BOORU_PRESETS.find((entry) => entry.key === provider);
  if (!preset) {
    await authRepo.upsertCredential(provider, updates, userId);
    return;
  }
  const existing = await booruSitesRepo.findBooruSiteByPresetKey(provider, userId);
  const username = updates.username !== undefined ? updates.username.trim() || null : existing?.username ?? null;
  const apiKey = updates.apiKey !== undefined ? updates.apiKey.trim() || null : existing?.apiKey ?? null;
  if (existing) {
    await booruSitesRepo.updateBooruSite(existing.id, { username, apiKey }, userId);
  } else {
    await booruSitesRepo.insertBooruSite(
      {
        name: preset.name,
        engine: preset.engine,
        baseUrl: preset.baseUrl,
        username,
        apiKey,
        isPreset: true,
        presetKey: preset.key,
        enabled: true,
        capFavorites: preset.defaultCapabilities.favorites,
        capTags: preset.defaultCapabilities.tags,
        capSourceMatch: preset.defaultCapabilities.sourceMatch,
        capSearch: preset.defaultCapabilities.search
      },
      userId
    );
  }
};
