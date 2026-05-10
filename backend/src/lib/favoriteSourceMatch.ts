import type { FavoriteProvider } from './dataStore';

// Registry of supported favorite providers. To add a new site:
//   1. Extend the `FavoriteProvider` union in dataStore.ts.
//   2. Add a `{provider, pattern}` entry here matching post URLs (capture
//      group 1 must be the remote post id).
//   3. Wire the network calls in services/favorites.ts FAVORITE_API_REGISTRY
//      (favorite + unfavorite). No other code needs to change.
export const FAVORITE_URL_PATTERNS: { provider: FavoriteProvider; pattern: RegExp }[] = [
  { provider: 'E621', pattern: /^https?:\/\/(?:www\.)?e621\.net\/posts\/(\d+)/i },
  { provider: 'DANBOORU', pattern: /^https?:\/\/(?:www\.)?danbooru\.donmai\.us\/posts\/(\d+)/i }
];

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
