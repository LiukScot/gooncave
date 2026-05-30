export type GalleryDetailSyncInput = {
  fileId?: string;
  selectedFileId?: string;
  hadSelectedFile: boolean;
};

export type GalleryDetailSyncAction =
  | { type: 'none' }
  | { type: 'set'; fileId: string }
  | { type: 'clear' };

export const getGalleryDetailSyncAction = ({
  fileId,
  selectedFileId,
  hadSelectedFile,
}: GalleryDetailSyncInput): GalleryDetailSyncAction => {
  if (selectedFileId && selectedFileId !== fileId) {
    return { type: 'set', fileId: selectedFileId };
  }
  if (!selectedFileId && fileId && hadSelectedFile) {
    return { type: 'clear' };
  }
  return { type: 'none' };
};
