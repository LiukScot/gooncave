import { isVideoUrl, mediaSrc } from './exploreMedia';

import type { ExplorePost } from '@/api';

const SIDE = 16;
const LOAD_TIMEOUT_MS = 2_500;
const CONCURRENCY = 6;

const comparable = (a: ExplorePost, b: ExplorePost): boolean => {
  if (!a.width || !a.height || !b.width || !b.height)
    return false;
  if (a.siteId === b.siteId &&
      (!a.uploader || !b.uploader ||
        a.uploader.toLowerCase() === b.uploader.toLowerCase()))
    return false;
  return Math.abs((a.width / a.height) / (b.width / b.height) - 1) <= 0.03;
};

const signature = (url: string, signal: AbortSignal): Promise<number[] | null> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(null);
    const image = new Image();
    let settled = false;
    const finish = (pixels: number[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      image.onload = null;
      image.onerror = null;
      if (!pixels) image.src = '';
      resolve(pixels);
    };
    const abort = () => finish(null);
    const timeout = setTimeout(abort, LOAD_TIMEOUT_MS);
    signal.addEventListener('abort', abort, { once: true });
    image.onerror = () => finish(null);
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SIDE;
        canvas.height = SIDE;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return finish(null);
        context.drawImage(image, 0, 0, SIDE, SIDE);
        const rgba = context.getImageData(0, 0, SIDE, SIDE).data;
        const rgb: number[] = [];
        for (let i = 0; i < rgba.length; i += 4) {
          rgb.push(rgba[i], rgba[i + 1], rgba[i + 2]);
        }
        finish(rgb);
      } catch {
        // A source that denies canvas access simply cannot be compared.
        finish(null);
      }
    };
    image.src = mediaSrc(url);
  });

/** Fingerprint plausible copies before they enter the grid. */
export async function withVisualMatches(
  posts: ExplorePost[],
  signal: AbortSignal
): Promise<ExplorePost[]> {
  const candidates = posts.filter((post, index) =>
    post.matchPreviewUrl &&
    !isVideoUrl(post.fileUrl) &&
    !['gif', 'mp4', 'webm', 'm4v', 'mov'].includes(post.fileExt?.toLowerCase() ?? '') &&
    posts.some((other, otherIndex) => index !== otherIndex && comparable(post, other))
  );
  if (!candidates.length) return posts;
  const matchingSignal = AbortSignal.any([signal, AbortSignal.timeout(LOAD_TIMEOUT_MS)]);
  const signatures = new Map<ExplorePost, number[]>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, async () => {
    while (next < candidates.length && !matchingSignal.aborted) {
      const post = candidates[next++];
      const pixels = await signature(post.matchPreviewUrl!, matchingSignal);
      if (pixels) signatures.set(post, pixels);
    }
  }));
  return posts.map((post) => {
    const visualSignature = signatures.get(post);
    return visualSignature ? { ...post, visualSignature } : post;
  });
}
