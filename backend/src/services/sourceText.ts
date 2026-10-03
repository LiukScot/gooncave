import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { favoritesRepo } from '../db/repos/favoritesRepo';
import { getEngine } from '../lib/booruEngines';
import type { PostText } from '../lib/booruEngines/types';

export type FileSourceText = {
  siteName: string;
  sourceUrl: string;
  title: string | null;
  description: string | null;
};

// A title and description rarely change after upload, and every read is a
// request against a site that rate-limits.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

// ponytail: in memory, so it is empty again after a restart. Store the text
// next to the favorite item if the remote reads ever become a problem.
const cache = new Map<string, { at: number; text: PostText | null }>();

const remember = (key: string, text: PostText | null) => {
  cache.delete(key);
  cache.set(key, { at: Date.now(), text });
  if (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value!);
  }
};

/**
 * The title and description of the posts a local file was saved from.
 *
 * Only sources whose booru has such text and returned some are listed, so a
 * file from a site without descriptions yields an empty list. A source that
 * fails to load is skipped rather than failing the others.
 */
export const describeFileSourceText = async (
  filePath: string,
  userId: string
): Promise<FileSourceText[]> => {
  const [favorites, sites] = await Promise.all([
    favoritesRepo.listFavoriteItemsByPath(filePath, userId),
    booruSitesRepo.listBooruSites(userId)
  ]);
  const siteByProvider = new Map(
    sites.flatMap((site) => [
      [site.id, site] as const,
      ...(site.presetKey ? [[site.presetKey, site] as const] : [])
    ])
  );

  const results: FileSourceText[] = [];
  for (const favorite of favorites) {
    const site = siteByProvider.get(favorite.provider);
    const engine = site ? getEngine(site.engine) : null;
    if (!site || !engine?.fetchPostText) continue;

    const key = `${site.id}:${favorite.remoteId}`;
    const cached = cache.get(key);
    let text = cached?.text ?? null;
    if (!cached || Date.now() - cached.at > CACHE_TTL_MS) {
      try {
        text = await engine.fetchPostText(site, favorite.remoteId);
        remember(key, text);
      } catch (err) {
        console.warn(
          `[source-text] ${site.name} ${favorite.remoteId}: ${(err as Error).message}`
        );
        continue;
      }
    }
    if (!text?.title && !text?.description) continue;
    results.push({
      siteName: site.name,
      sourceUrl:
        favorite.sourceUrl || engine.buildPostUrl(site, favorite.remoteId),
      title: text.title,
      description: text.description
    });
  }
  return results;
};
