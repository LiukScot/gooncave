import { getEngine } from './booruEngines';
import type { BooruSiteRecord, FavoriteProvider } from './dataStore';

// Legacy hardcoded patterns. Kept as a fallback so that callers without
// per-user site context (e.g. workers operating before login) can still match
// the canonical e621.net / danbooru.donmai.us URLs. New code should prefer
// `extractFavoriteRemoteFromSiteList(url, sites)`.
export const FAVORITE_URL_PATTERNS: { provider: FavoriteProvider; pattern: RegExp }[] = [
  { provider: 'E621', pattern: /^https?:\/\/(?:www\.)?e621\.net\/posts\/(\d+)/i },
  { provider: 'DANBOORU', pattern: /^https?:\/\/(?:www\.)?danbooru\.donmai\.us\/posts\/(\d+)/i }
];

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

// Legacy fallback that does NOT consult user sites. Use only for code paths
// that have no userId available. New code should call
// `extractFavoriteRemoteFromSiteList`.
export const extractFavoriteRemoteFromSourceUrl = (
  sourceUrl: string | null | undefined
): { provider: FavoriteProvider; remoteId: string } | null => {
  if (!sourceUrl) return null;
  for (const { provider, pattern } of FAVORITE_URL_PATTERNS) {
    const m = sourceUrl.match(pattern);
    if (m) return { provider, remoteId: m[1] };
  }
  return null;
};
