import type { FileItem } from '@/api';

// iPhone reads video frames with AVFoundation, which does not open these.
const IOS_UNREADABLE = new Set(['webm', 'mkv', 'avi', 'wmv', 'flv']);

/**
 * Why a tile has no preview, in words the person can act on. Null for a picture the site did
 * not refuse, which keeps the plain "image" label.
 */
export const noPreviewReason = (
  file: Pick<FileItem, 'path' | 'mediaType' | 'locationType' | 'favoriteProviders' | 'previewProblem'>,
  ios: boolean
): string | null => {
  if (file.previewProblem) return file.previewProblem;
  if (file.mediaType !== 'VIDEO') return null;
  if (file.locationType === 'REMOTE') {
    return file.favoriteProviders?.length
      ? 'No preview yet. GoonCave is downloading one from the site.'
      : 'No preview yet. The video is not on this device. Open it to download it.';
  }
  const extension = file.path.split('.').pop()?.toLowerCase() ?? '';
  if (ios && IOS_UNREADABLE.has(extension)) {
    return `iPhone cannot make a preview of .${extension} videos. Open the video to watch it.`;
  }
  return 'No preview yet. Open the video to watch it.';
};
