export type GalleryDetailSyncInput = {
  fileId?: string;
  selectedFileId?: string;
  hadSelectedFile: boolean;
};

export type GalleryDetailHydrationInput = {
  fileId?: string;
  selectedFileId?: string;
  previousFileId?: string;
  previousSelectedFileId?: string;
};

export type GalleryDetailSyncAction =
  | { type: 'none' }
  | { type: 'set'; fileId: string }
  | { type: 'clear' };

export const getGalleryDetailSyncAction = ({
  fileId,
  selectedFileId,
  hadSelectedFile
}: GalleryDetailSyncInput): GalleryDetailSyncAction => {
  if (selectedFileId && selectedFileId !== fileId) {
    return { type: 'set', fileId: selectedFileId };
  }
  if (!selectedFileId && fileId && hadSelectedFile) {
    return { type: 'clear' };
  }
  return { type: 'none' };
};

export const shouldApplyFileIdToSelection = ({
  fileId,
  selectedFileId,
  previousFileId,
  previousSelectedFileId
}: GalleryDetailHydrationInput): boolean => {
  if (!fileId) return false;
  if (selectedFileId === fileId) return false;

  if (!selectedFileId && previousSelectedFileId) {
    // Local close cleared selection; URL clear is pending (fileId may still lag).
    return false;
  }

  const fileIdStable = previousFileId === fileId;

  if (fileIdStable && selectedFileId && selectedFileId !== fileId) {
    // Local next/prev changed selection; URL update effect runs after this.
    return false;
  }

  return true;
};
