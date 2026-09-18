import { API_BASE, type BooruEngineType } from '@/api';

/**
 * Whether a remote post is a video, decided from its file extension.
 *
 * Boorus do not agree on a media-type field — e621 has none on the post,
 * gelbooru forks vary — but every one of them serves the file at a URL that
 * still carries its extension. Query strings are stripped first: CDN links
 * routinely end in `?123456`.
 *
 * GIFs are deliberately not video: an <img> animates them, while a <video>
 * would refuse to play them at all.
 */
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.m4v', '.mov'];

export const isVideoUrl = (url: string | null): boolean => {
  if (!url) return false;
  const path = url.split(/[?#]/)[0].toLowerCase();
  return VIDEO_EXTENSIONS.some((extension) => path.endsWith(extension));
};

// These engines expose a separate resized still. Others expose only a
// thumbnail or repeat the original file as their sample.
const GRID_SAMPLE_ENGINES = new Set<BooruEngineType>([
  'e621',
  'danbooru',
  'gelbooru',
  'moebooru',
  'sankaku'
]);

export const gridImageUrlFor = (
  post: {
    engine: BooruEngineType;
    previewUrl: string | null;
    sampleUrl: string | null;
    fileUrl: string | null;
  },
  needsTallSample: boolean
): string | null => {
  const sample = post.sampleUrl;
  if (
    sample &&
    !isVideoUrl(sample) &&
    (GRID_SAMPLE_ENGINES.has(post.engine) || needsTallSample)
  ) {
    return sample;
  }
  return post.previewUrl ?? (sample && !isVideoUrl(sample) ? sample : null);
};

/**
 * Best URL to display a post with.
 *
 * For video the sample is a still frame on most boorus, so the full file is
 * the only thing that actually plays. For stills the sample is the point:
 * it is sized for viewing, where the original can be a 20 MB PNG.
 */
export const displayUrlFor = (post: {
  sampleUrl: string | null;
  fileUrl: string | null;
  previewUrl: string | null;
}): string | null =>
  isVideoUrl(post.fileUrl)
    ? post.fileUrl
    : (post.sampleUrl ?? post.fileUrl ?? post.previewUrl);

/**
 * The src an <img> loads a post's media from. Previews come back from the
 * server as a relative path to its media cache, like a library thumbUrl, and
 * need the API base in front; a booru url is used as it is.
 */
export const mediaSrc = (url: string): string =>
  url.startsWith('/') ? `${API_BASE}${url}` : url;

/**
 * A CSS `url("…")` value for a post's media. Only the characters that could
 * end the quoted string are escaped: the cached path is already
 * percent-encoded, and encoding it again breaks its signature.
 */
export const cssImageUrl = (url: string): string =>
  `url("${mediaSrc(url).replace(/["\\\n]/g, encodeURIComponent)}")`;
