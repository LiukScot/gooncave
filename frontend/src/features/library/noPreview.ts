import type { FileItem } from '@/api';

// iPhone reads video frames with AVFoundation, which does not open these.
const IOS_UNREADABLE = new Set(['webm', 'mkv', 'avi', 'wmv', 'flv']);

/**
 * Why a video tile has no preview, in words the person can act on. Null for anything that is
 * not a video, which keeps the plain "image" label.
 */
export const noPreviewReason = (
  file: Pick<FileItem, 'path' | 'mediaType' | 'locationType'>,
  ios: boolean
): string | null => {
  if (file.mediaType !== 'VIDEO') return null;
  if (file.locationType === 'REMOTE') {
    return 'No preview yet. The device that has the video makes it. Open the video to watch it.';
  }
  const extension = file.path.split('.').pop()?.toLowerCase() ?? '';
  if (ios && IOS_UNREADABLE.has(extension)) {
    return `iPhone cannot make a preview of .${extension} videos. Open the video to watch it.`;
  }
  return 'No preview yet. Open the video to watch it.';
};
