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
