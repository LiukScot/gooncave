import { isVideoUrl } from './exploreMedia';

import { api, type ExplorePost } from '@/api';

type ExplorePostDetails = Awaited<ReturnType<typeof api.exploreDetailTags>>;
type ExplorePostRef = Pick<ExplorePost, 'siteId' | 'remoteId'>;

const detailRequests = new Map<string, Promise<ExplorePostDetails>>();
const imagePreloads = new Map<string, HTMLImageElement>();
const preloadedImageUrls = new Set<string>();

const postKey = (post: ExplorePostRef): string =>
  `${post.siteId}:${post.remoteId}`;

export const loadExplorePostDetails = (
  post: ExplorePostRef
): Promise<ExplorePostDetails> => {
  const key = postKey(post);
  const cached = detailRequests.get(key);
  if (cached) return cached;

  let pending = api.exploreDetailTags(post.siteId, post.remoteId);
  pending = pending.catch((error: unknown) => {
    if (detailRequests.get(key) === pending) detailRequests.delete(key);
    throw error;
  });
  detailRequests.set(key, pending);
  return pending;
};

export const preloadFurAffinityImage = async (
  post: ExplorePost
): Promise<void> => {
  if (post.engine !== 'furaffinity' || post.fileUrl) return;

  const details = await loadExplorePostDetails(post);
  const { fileUrl } = details;
  if (!fileUrl || isVideoUrl(fileUrl) || preloadedImageUrls.has(fileUrl)) return;

  const image = new Image();
  image.decoding = 'async';
  image.referrerPolicy = 'origin';
  image.onload = () => imagePreloads.delete(fileUrl);
  image.onerror = () => {
    imagePreloads.delete(fileUrl);
    preloadedImageUrls.delete(fileUrl);
  };
  preloadedImageUrls.add(fileUrl);
  imagePreloads.set(fileUrl, image);
  image.src = fileUrl;
};

export const preloadAdjacentFurAffinityImages = async (
  currentPost: ExplorePost,
  nextPost: ExplorePost | null,
  prevPost: ExplorePost | null
): Promise<void> => {
  if (currentPost.engine === 'furaffinity' && !currentPost.fileUrl) {
    try {
      await loadExplorePostDetails(currentPost);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[explore] FurAffinity neighbour preload skipped because current post ${currentPost.remoteId} failed: ${message}`
      );
      return;
    }
  }

  for (const neighbour of [nextPost, prevPost]) {
    if (!neighbour) continue;
    try {
      await preloadFurAffinityImage(neighbour);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[explore] FurAffinity neighbour preload failed for ${neighbour.remoteId}: ${message}`
      );
    }
  }
};
