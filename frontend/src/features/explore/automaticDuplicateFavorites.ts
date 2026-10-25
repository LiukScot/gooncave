import { stackDuplicates } from './stackDuplicates';

import type { ExplorePost } from '@/api';

const GALLERY_MATCH_BATCH_SIZE = 100;

export const galleryMatchBatches = <T>(items: T[]): T[][] => {
  const batches: T[][] = [];
  for (
    let offset = 0;
    offset < items.length;
    offset += GALLERY_MATCH_BATCH_SIZE
  ) {
    batches.push(items.slice(offset, offset + GALLERY_MATCH_BATCH_SIZE));
  }
  return batches;
};

export const automaticDuplicateFavoriteTargets = (
  posts: ExplorePost[],
  isFavorited: (post: ExplorePost) => boolean,
  canFavorite: (post: ExplorePost) => boolean
): ExplorePost[] => {
  const selected = new Map<string, ExplorePost>();
  const wanted = (post: ExplorePost) =>
    !post.favoriteDeclined && !isFavorited(post) && canFavorite(post);
  for (const post of posts) {
    if (post.galleryFavoriteMatch && wanted(post)) {
      selected.set(`${post.siteId}:${post.remoteId}`, post);
    }
  }
  for (const stack of stackDuplicates(posts)) {
    if (!stack.some(isFavorited)) continue;
    for (const post of stack) {
      if (wanted(post)) {
        selected.set(`${post.siteId}:${post.remoteId}`, post);
      }
    }
  }
  return [...selected.values()];
};

/** The other favorited copies of the picture `post` shows, which leave the favorites with it. */
export const copiesToUnfavorite = (
  posts: ExplorePost[],
  post: ExplorePost,
  isFavorited: (post: ExplorePost) => boolean
): ExplorePost[] => {
  const same = (a: ExplorePost, b: ExplorePost) =>
    a.siteId === b.siteId && a.remoteId === b.remoteId;
  return stackDuplicates(posts)
    .filter((stack) => stack.some((entry) => same(entry, post)))
    .flat()
    .filter((copy) => !same(copy, post) && isFavorited(copy));
};

export type AutomaticFavoriteQueueItem = {
  generation: number;
  post: ExplorePost;
};

export const drainAutomaticFavoriteQueue = async (
  queue: AutomaticFavoriteQueueItem[],
  currentGeneration: () => number,
  favorite: (post: ExplorePost) => Promise<void>
): Promise<void> => {
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.generation !== currentGeneration()) continue;
    await favorite(item.post);
  }
};
