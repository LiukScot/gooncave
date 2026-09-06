import { favoritesRepo } from '../db/repos/favoritesRepo';
import type { BooruSiteRecord } from '../db/types';
import type { BooruEngineModule, RemotePost } from '../lib/booruEngines/types';
import { todayIso } from '../lib/booruEngines/windowRange';
import { siteKey } from '../lib/siteKey';

import type { ExplorePost } from './explore';

/**
 * Reading booru posts that are not part of a search: the relatives of a post,
 * the pages of a pool. Shared so both read the same way — as whole posts,
 * marked with the library file holding them where there is one, because a
 * click has to be able to open them inside GoonCave.
 */

/** A post plus what this library knows about it. */
export type LibraryAwarePost = ExplorePost & {
  /** The library file holding this post, when it was already saved. */
  localFileId: string | null;
};

/** One search whose whole query is a metatag, in the engine's own order. */
export const searchByMetatag = async (
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  metatag: string,
  limit: number
): Promise<RemotePost[]> => {
  const { posts } = await engine.searchPosts!(site, {
    tags: [metatag],
    sort: 'new',
    window: 'day',
    date: todayIso(),
    page: 1,
    limit
  });
  return posts;
};

/** Boorus accept an id list as one metatag; this is how many fit in one. */
const ID_BATCH = 100;

/**
 * The given posts, in the given order — which is the caller's order, not the
 * booru's: a pool's pages are meaningless sorted by id.
 */
export const postsByIds = async (
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  ids: readonly string[]
): Promise<RemotePost[]> => {
  const found = new Map<string, RemotePost>();
  for (let start = 0; start < ids.length; start += ID_BATCH) {
    const batch = ids.slice(start, start + ID_BATCH);
    const posts = await searchByMetatag(
      site,
      engine,
      `id:${batch.join(',')}`,
      batch.length
    );
    for (const post of posts) found.set(post.remoteId, post);
  }
  // A post the booru dropped (deleted, or hidden from this account) leaves a
  // gap rather than shifting everything after it into the wrong position.
  return ids.map((id) => found.get(id)).filter((post) => post !== undefined);
};

const withLibraryFile = (
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  post: RemotePost,
  localFileId: string | null
): LibraryAwarePost => ({
  ...post,
  // The booru's own answer where it gave one, and otherwise what the
  // library knows — the same order of trust the explore grid uses.
  favorited: post.favorited ?? localFileId !== null,
  siteId: site.id,
  siteName: site.name,
  engine: site.engine,
  sourceUrl: engine.buildPostUrl(site, post.remoteId),
  localFileId
});

/**
 * A whole set of posts, each marked with the library file holding it. The
 * library is asked once for the set rather than twice per post: a pool page
 * is sixty of them.
 */
export const toLibraryAwarePosts = async (
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  posts: readonly RemotePost[],
  userId: string
): Promise<LibraryAwarePost[]> => {
  const held = await favoritesRepo.findLibraryFilesByRemoteIds(
    siteKey(site),
    posts.map((post) => post.remoteId),
    userId
  );
  return posts.map((post) =>
    withLibraryFile(site, engine, post, held.get(post.remoteId) ?? null)
  );
};

export const toLibraryAwarePost = async (
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  post: RemotePost,
  userId: string
): Promise<LibraryAwarePost> =>
  (await toLibraryAwarePosts(site, engine, [post], userId))[0];
