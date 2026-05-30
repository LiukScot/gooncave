import { describe, expect, it } from 'vitest';

import { getGalleryDetailSyncAction } from '../src/features/shell/galleryDetailSync';

describe('getGalleryDetailSyncAction', () => {
  it('keeps URL during initial deep-link hydration before selection resolves', () => {
    expect(
      getGalleryDetailSyncAction({
        fileId: 'abc',
        selectedFileId: undefined,
        hadSelectedFile: false,
      }),
    ).toEqual({ type: 'none' });
  });

  it('updates URL when selection changes after navigation/delete-next flow', () => {
    expect(
      getGalleryDetailSyncAction({
        fileId: 'abc',
        selectedFileId: 'def',
        hadSelectedFile: true,
      }),
    ).toEqual({ type: 'set', fileId: 'def' });
  });

  it('clears URL after a selected file closes', () => {
    expect(
      getGalleryDetailSyncAction({
        fileId: 'abc',
        selectedFileId: undefined,
        hadSelectedFile: true,
      }),
    ).toEqual({ type: 'clear' });
  });
});
