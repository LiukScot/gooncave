import { getEngine } from './booruEngines';
import type { BooruSiteRecord, FavoriteProvider } from './dataStore';

// Per-user URL matcher built from the caller's `user_booru_sites` rows. Only
// considers sites with `capSourceMatch = true` and `enabled = true`, in
// ascending `sortOrder`. Returns the site id as the `provider` value so the
// caller can persist a `favorite_items.provider = site.id` row that uniquely
// identifies which configured site originated the match.
export const extractFavoriteRemoteFromSiteList = (
  sourceUrl: string | null | undefined,
  sites: BooruSiteRecord[]
): { provider: FavoriteProvider; remoteId: string; site: BooruSiteRecord } | null => {
  if (!sourceUrl) return null;
  const ordered = [...sites]
    .filter((site) => site.enabled && site.capSourceMatch)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  for (const site of ordered) {
    const engine = getEngine(site.engine);
    if (!engine) continue;
    const result = engine.extractIdFromUrl(sourceUrl, site);
    if (result) {
      return { provider: site.id, remoteId: result.remoteId, site };
    }
  }
  return null;
};
