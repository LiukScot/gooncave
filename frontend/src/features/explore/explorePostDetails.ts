import { isVideoUrl, mediaSrc } from './exploreMedia';

import { api, type ExplorePost } from '@/api';

type ExplorePostDetails = Awaited<ReturnType<typeof api.exploreDetailTags>>;
type ExplorePostRef = Pick<ExplorePost, 'siteId' | 'remoteId'>;

const detailRequests = new Map<string, Promise<ExplorePostDetails>>();
const imagePreloads = new Map<string, HTMLImageElement>();
const preloadedImageUrls = new Set<string>();
type GridPreviewRequest = {
  promise: Promise<string | null>;
  controller: AbortController;
  consumers: number;
  permanent: boolean;
  settled: boolean;
};
const gridPreviewRequests = new Map<string, GridPreviewRequest>();
const gridPreviewQueue: Array<() => void> = [];
let activeGridPreviews = 0;
const MAX_ACTIVE_GRID_PREVIEWS = 2;
const GRID_PREVIEW_TIMEOUT_MS = 20_000;

const postKey = (post: ExplorePostRef): string =>
  `${post.siteId}:${post.remoteId}`;

const runGridPreviewQueue = (): void => {
  while (activeGridPreviews < MAX_ACTIVE_GRID_PREVIEWS) {
    const start = gridPreviewQueue.shift();
    if (!start) return;
    activeGridPreviews += 1;
    start();
  }
};

const queueGridPreview = (
  task: () => Promise<string | null>,
  signal?: AbortSignal
): Promise<string | null> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve(null);
    const start = () => {
      signal?.removeEventListener('abort', cancelQueued);
      void Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          activeGridPreviews -= 1;
          runGridPreviewQueue();
        });
    };
    const cancelQueued = () => {
      const index = gridPreviewQueue.indexOf(start);
      if (index < 0) return;
      gridPreviewQueue.splice(index, 1);
      resolve(null);
    };
    signal?.addEventListener('abort', cancelQueued, { once: true });
    gridPreviewQueue.push(start);
    runGridPreviewQueue();
  });

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

export const loadFurAffinityGridPreview = (
  post: ExplorePostRef,
  signal?: AbortSignal
): Promise<string | null> => {
  if (signal?.aborted) return Promise.resolve(null);
  const key = postKey(post);
  let request = gridPreviewRequests.get(key);
  if (!request) {
    const controller = new AbortController();
    request = {
      promise: Promise.resolve(null), controller, consumers: 0,
      permanent: false, settled: false
    };
    const current = request;
    request.promise = queueGridPreview(async () => {
      const { fileUrl } = await loadExplorePostDetails(post);
      if (controller.signal.aborted || !fileUrl || isVideoUrl(fileUrl)) return null;
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.decoding = 'async';
        image.referrerPolicy = 'origin';
        let finished = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          window.clearTimeout(timeout);
          controller.signal.removeEventListener('abort', abort);
          image.onload = null;
          image.onerror = null;
          if (error) reject(error);
          else resolve();
        };
        const abort = () => {
          image.src = '';
          finish();
        };
        const timeout = window.setTimeout(() => {
          image.src = '';
          finish(new Error(`Full preview timed out for ${key}`));
        }, GRID_PREVIEW_TIMEOUT_MS);
        controller.signal.addEventListener('abort', abort, { once: true });
        image.onload = () => finish();
        image.onerror = () => finish(new Error(`Full preview failed for ${key}`));
        image.src = mediaSrc(fileUrl);
      });
      return controller.signal.aborted ? null : fileUrl;
    }, controller.signal)
      .then((fileUrl) => {
        current.settled = true;
        if (controller.signal.aborted && gridPreviewRequests.get(key) === current) {
          gridPreviewRequests.delete(key);
        }
        return fileUrl;
      }, (error: unknown) => {
        current.settled = true;
        if (gridPreviewRequests.get(key) === current) gridPreviewRequests.delete(key);
        throw error;
      });
    gridPreviewRequests.set(key, request);
  }
  if (!signal) {
    request.permanent = true;
    return request.promise;
  }
  request.consumers += 1;
  const current = request;
  return new Promise((resolve, reject) => {
    let finished = false;
    const detach = () => {
      if (finished) return false;
      finished = true;
      signal.removeEventListener('abort', abort);
      current.consumers -= 1;
      if (!current.settled && !current.permanent && current.consumers === 0) {
        if (gridPreviewRequests.get(key) === current) gridPreviewRequests.delete(key);
        current.controller.abort();
      }
      return true;
    };
    const abort = () => {
      if (detach()) resolve(null);
    };
    signal.addEventListener('abort', abort, { once: true });
    void current.promise.then(
      (fileUrl) => { if (detach()) resolve(fileUrl); },
      (error: unknown) => { if (detach()) reject(error); }
    );
  });
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
  image.src = mediaSrc(fileUrl);
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
