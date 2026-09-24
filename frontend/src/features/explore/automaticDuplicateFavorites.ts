import { stackDuplicates } from './stackDuplicates';

import type { ExplorePost } from '@/api';

export const automaticDuplicateFavoriteTargets = (
  posts: ExplorePost[],
  isFavorited: (post: ExplorePost) => boolean,
  canFavorite: (post: ExplorePost) => boolean
): ExplorePost[] =>
  stackDuplicates(posts).flatMap((stack) => {
    if (!stack.some(isFavorited)) return [];
    return stack.filter(
      (post) => !isFavorited(post) && canFavorite(post)
    );
  });

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
