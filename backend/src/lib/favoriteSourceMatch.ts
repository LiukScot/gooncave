import type { FavoriteProvider } from './dataStore';

const e621PostUrlPattern = /^https?:\/\/(?:www\.)?e621\.net\/posts\/(\d+)/i;
const danbooruPostUrlPattern = /^https?:\/\/(?:www\.)?danbooru\.donmai\.us\/posts\/(\d+)/i;

export const extractFavoriteRemoteFromSourceUrl = (
  sourceUrl: string | null | undefined
): { provider: FavoriteProvider; remoteId: string } | null => {
  if (!sourceUrl) return null;
  const e621Match = sourceUrl.match(e621PostUrlPattern);
  if (e621Match) return { provider: 'E621', remoteId: e621Match[1] };
  const danbooruMatch = sourceUrl.match(danbooruPostUrlPattern);
  if (danbooruMatch) return { provider: 'DANBOORU', remoteId: danbooruMatch[1] };
  return null;
};
