import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { filesRepo } from '../db/repos/filesRepo';
import type { BooruSiteRecord } from '../db/types';
import { getEngine } from '../lib/booruEngines';
import { redactUrlSecrets } from '../lib/booruEngines/helpers';
import type {
  BooruEngineModule,
  PostRelations,
  RemotePost
} from '../lib/booruEngines/types';
import { createTtlCache } from '../lib/ttlCache';

import {
  searchByMetatag,
  toLibraryAwarePosts,
  type LibraryAwarePost
} from './booruPosts';

/**
 * Parent/child posts — the same picture uploaded twice, an alternate version,
 * the uncensored take. The boorus that have the concept expose it as one
 * parent id per post plus a "has children" flag, and list a group with the
 * `parent:` metatag, so nothing here needs an engine method of its own.
 */

/**
 * One member of a group. A whole post rather than a thumbnail and a link:
 * clicking one opens it inside GoonCave, which needs everything the detail
 * view shows.
 */
export type RelatedPost = LibraryAwarePost & {
  /** The post the others descend from. */
  isParent: boolean;
  /** The post the carousel was opened from. */
  isCurrent: boolean;
};

/** A parent holds a handful of variants; one page covers the whole group. */
const GROUP_LIMIT = 40;

/**
 * Listing a group costs one or two booru reads, and the detail view asks on
 * every open — paging back and forth through a set otherwise repeats them.
 * Only the booru's half is kept: which of the posts this account holds is a
 * local lookup, and stale answers there would send a click to the wrong page.
 */
const groupCache = createTtlCache<RemotePost[]>(5 * 60_000, 200);

const relationEngine = (site: BooruSiteRecord): BooruEngineModule | null => {
  const engine = getEngine(site.engine);
  if (!engine?.searchPosts || !engine.supportsRelations) return null;
  return engine;
};

/** What the booru says about one post's group. `null` when it cannot say. */
export const fetchPostRelations = async (
  site: BooruSiteRecord,
  remoteId: string
): Promise<PostRelations | null> => {
  const engine = relationEngine(site);
  if (!engine) return null;
  const posts = await searchByMetatag(
    site,
    engine,
    `id:${remoteId}`,
    GROUP_LIMIT
  );
  const post = posts.find((entry) => entry.remoteId === remoteId);
  if (!post) return null;
  return {
    parentId: post.parentId,
    hasChildren: post.hasChildren,
    poolIds: post.poolIds
  };
};

/** The parent and its children, parent first, as the booru has them now. */
const readGroup = async (
  site: BooruSiteRecord,
  engine: BooruEngineModule,
  rootId: string
): Promise<RemotePost[]> => {
  const found = await searchByMetatag(
    site,
    engine,
    `parent:${rootId}`,
    GROUP_LIMIT
  );
  // danbooru answers `parent:` with the parent among the results, e621 with
  // the children alone. Reading the parent again where it is missing costs
  // one request and keeps that difference out of every engine module.
  const root =
    found.find((post) => post.remoteId === rootId) ??
    (await searchByMetatag(site, engine, `id:${rootId}`, GROUP_LIMIT)).find(
      (post) => post.remoteId === rootId
    ) ??
    null;
  return [
    ...(root ? [root] : []),
    ...found.filter((post) => post.remoteId !== rootId)
  ];
};

/**
 * The whole group a post belongs to, parent first. Empty when the post has
 * no relatives, or when the booru answered without them — a strip holding
 * only the post already on screen is noise, not information.
 */
export const listRelatedPosts = async (
  site: BooruSiteRecord,
  remoteId: string,
  relations: Pick<PostRelations, 'parentId' | 'hasChildren'>,
  userId: string
): Promise<RelatedPost[]> => {
  const engine = relationEngine(site);
  if (!engine) return [];
  // A post the booru called childless is only trustworthy where the booru
  // reports children at all: rule34 and the other gelbooru-style APIs send
  // `parent_id` and nothing else, so there a parent is indistinguishable
  // from a lone post until the `parent:` search below answers.
  if (
    !relations.parentId &&
    !relations.hasChildren &&
    engine.reportsHasChildren
  ) {
    return [];
  }
  const rootId = relations.parentId ?? remoteId;
  const cacheKey = `${site.id}:${rootId}`;
  const group =
    groupCache.get(cacheKey) ?? (await readGroup(site, engine, rootId));
  groupCache.set(cacheKey, group);
  if (group.length < 2) return [];
  return (await toLibraryAwarePosts(site, engine, group, userId)).map(
    (post) => ({
      ...post,
      isParent: post.remoteId === rootId,
      isCurrent: post.remoteId === remoteId
    })
  );
};

const resolveSite = async (
  source: string,
  userId: string
): Promise<BooruSiteRecord | null> =>
  (await booruSitesRepo.getBooruSite(source, userId)) ??
  (await booruSitesRepo.findBooruSiteByPresetKey(source, userId));

/**
 * Stores what the booru says about a file's post, so the gallery grid can
 * mark it without asking. Called right after a post was read for its tags,
 * with what that read already learned where the engine could say — and
 * never again once a row exists.
 */
export const rememberFileRelations = async (
  fileId: string,
  source: string,
  site: BooruSiteRecord,
  remoteId: string,
  known: PostRelations | null = null
): Promise<void> => {
  if (!relationEngine(site)) return;
  const stored = await filesRepo.listRelationsForFile(fileId);
  if (stored.some((entry) => entry.source === source)) return;
  // The caller read the post's own page for its tags and that body carries
  // this too, so asking the booru again would be the same answer twice.
  const relations = known ?? (await fetchPostRelations(site, remoteId));
  if (!relations) return;
  await filesRepo.upsertFileRelation({
    fileId,
    source,
    remoteId,
    parentId: relations.parentId,
    hasChildren: relations.hasChildren,
    poolIds: relations.poolIds
  });
};

/** The booru posts a local file's tags were read from, one per source. */
export const remoteOrigins = async (
  fileId: string,
  userId: string
): Promise<{ source: string; site: BooruSiteRecord; remoteId: string }[]> => {
  const tags = await filesRepo.listTagsForFile(fileId);
  const origins = new Map<
    string,
    { source: string; site: BooruSiteRecord; remoteId: string }
  >();
  // A file carries every tag from a source, so without this the two lookups
  // below run again for each of them — and a source that cannot be resolved
  // never lands in `origins` to stop them.
  const attempted = new Set<string>();
  for (const tag of tags) {
    if (!tag.sourceUrl || attempted.has(tag.source)) continue;
    attempted.add(tag.source);
    const site = await resolveSite(tag.source, userId);
    if (!site) continue;
    const extracted = getEngine(site.engine)?.extractIdFromUrl(
      tag.sourceUrl,
      site
    );
    if (!extracted) continue;
    origins.set(tag.source, {
      source: tag.source,
      site,
      remoteId: extracted.remoteId
    });
  }
  return [...origins.values()];
};

/**
 * The group a local file's post belongs to. Reads the booru only when
 * nothing is stored yet, and stores what it learns: the grid icon for a file
 * nobody has opened comes from the same rows.
 */
export const describeFileRelations = async (
  fileId: string,
  userId: string
): Promise<{ posts: RelatedPost[] }> => {
  const stored = await filesRepo.listRelationsForFile(fileId);
  for (const origin of await remoteOrigins(fileId, userId)) {
    const known = stored.find(
      (entry) =>
        entry.source === origin.source && entry.remoteId === origin.remoteId
    );
    let relations: PostRelations | null = known
      ? {
          parentId: known.parentId,
          hasChildren: known.hasChildren,
          poolIds: known.poolIds
        }
      : null;
    try {
      if (!relations) {
        relations = await fetchPostRelations(origin.site, origin.remoteId);
        if (relations) {
          await filesRepo.upsertFileRelation({
            fileId,
            source: origin.source,
            remoteId: origin.remoteId,
            parentId: relations.parentId,
            hasChildren: relations.hasChildren,
            poolIds: relations.poolIds
          });
        }
      }
      if (!relations) continue;
      const posts = await listRelatedPosts(
        origin.site,
        origin.remoteId,
        relations,
        userId
      );
      if (posts.length) return { posts };
    } catch (err) {
      // A site that will not answer must not take the detail view down with
      // it: the section is one strip of thumbnails among a page of others.
      console.warn(
        `[relations] ${origin.site.name} failed for file ${fileId}: ${redactUrlSecrets((err as Error).message)}`
      );
    }
  }
  return { posts: [] };
};
