import { describe, expect, it } from 'vitest';

import {
  getGalleryDetailSyncAction,
  shouldApplyFileIdToSelection
} from './galleryDetailSync';

describe('getGalleryDetailSyncAction', () => {
  it('sets fileId in URL when selection changes', () => {
    expect(
      getGalleryDetailSyncAction({
        fileId: 'one',
        selectedFileId: 'two',
        hadSelectedFile: true
      })
    ).toEqual({ type: 'set', fileId: 'two' });
  });

  it('clears fileId from URL after close', () => {
    expect(
      getGalleryDetailSyncAction({
        fileId: 'one',
        selectedFileId: undefined,
        hadSelectedFile: true
      })
    ).toEqual({ type: 'clear' });
  });
});

describe('shouldApplyFileIdToSelection', () => {
  it('skips URL hydration while local next/prev is waiting to sync URL', () => {
    expect(
      shouldApplyFileIdToSelection({
        fileId: 'one',
        selectedFileId: 'two',
        previousFileId: 'one',
        previousSelectedFileId: 'one'
      })
    ).toBe(false);
  });

  it('skips URL hydration right after local close', () => {
    expect(
      shouldApplyFileIdToSelection({
        fileId: 'one',
        selectedFileId: undefined,
        previousFileId: 'one',
        previousSelectedFileId: 'one'
      })
    ).toBe(false);
  });

  it('skips URL hydration after close when URL lags behind selection', () => {
    expect(
      shouldApplyFileIdToSelection({
        fileId: 'one',
        selectedFileId: undefined,
        previousFileId: 'one',
        previousSelectedFileId: 'two'
      })
    ).toBe(false);
  });

  it('applies URL hydration for deep-link state without selected file', () => {
    expect(
      shouldApplyFileIdToSelection({
        fileId: 'one',
        selectedFileId: undefined,
        previousFileId: 'one',
        previousSelectedFileId: undefined
      })
    ).toBe(true);
  });
});
