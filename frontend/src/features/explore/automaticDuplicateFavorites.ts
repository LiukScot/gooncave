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
  for (const post of posts) {
    if (post.galleryFavoriteMatch && !isFavorited(post) && canFavorite(post)) {
      selected.set(`${post.siteId}:${post.remoteId}`, post);
    }
  }
  for (const stack of stackDuplicates(posts)) {
    if (!stack.some(isFavorited)) continue;
    for (const post of stack) {
      if (!isFavorited(post) && canFavorite(post)) {
        selected.set(`${post.siteId}:${post.remoteId}`, post);
      }
    }
  }
  return [...selected.values()];
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
