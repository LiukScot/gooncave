import { describe, expect, it } from 'vitest';

import { nextSavedGalleryScroll } from '../src/features/file-detail/galleryScroll';

describe('nextSavedGalleryScroll', () => {
  it('captures the live scroll on the initial gallery open', () => {
    expect(
      nextSavedGalleryScroll({
        hasOpenFile: false,
        currentScroll: 1200,
        savedScroll: 0
      })
    ).toBe(1200);
  });

  it('keeps the saved scroll when navigating prev/next in detail view', () => {
    // Regression guard: while a file is open the window is at the top
    // (currentScroll === 0). Re-capturing here would reset the gallery to the
    // top on close. The saved position must survive navigation.
    expect(
      nextSavedGalleryScroll({
        hasOpenFile: true,
        currentScroll: 0,
        savedScroll: 1200
      })
    ).toBe(1200);
  });
});
