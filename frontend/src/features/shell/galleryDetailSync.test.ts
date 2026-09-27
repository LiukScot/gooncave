import { describe, expect, it } from 'vitest';

import { getDetailUrlSyncAction } from './galleryDetailSync';

describe('getDetailUrlSyncAction', () => {
  it('opens the file when the URL gains one', () => {
    expect(
      getDetailUrlSyncAction({
        urlFileId: 'a',
        previousUrlFileId: undefined,
        selectedFileId: undefined
      })
    ).toEqual({ type: 'open', fileId: 'a' });
  });

  // Deep link / reload: the gallery has not fetched the file yet, so the
  // caller keeps `previousUrlFileId` unset and this stays 'open' until the
  // file shows up, rather than deciding the URL is stale and wiping it.
  it('keeps asking to open while the selection has not caught up', () => {
    const input = {
      urlFileId: 'a',
      previousUrlFileId: undefined,
      selectedFileId: undefined
    } as const;
    expect(getDetailUrlSyncAction(input)).toEqual({
      type: 'open',
      fileId: 'a'
    });
    // Same inputs again, simulating the gallery page still not having
    // fetched the file on a later pass — must keep asking to open, not
    // flip to 'close' just because it didn't work the first time.
    expect(getDetailUrlSyncAction(input)).toEqual({
      type: 'open',
      fileId: 'a'
    });
  });

  it('closes the detail when the URL loses its file', () => {
    expect(
      getDetailUrlSyncAction({
        urlFileId: undefined,
        previousUrlFileId: 'a',
        selectedFileId: 'a'
      })
    ).toEqual({ type: 'close' });
  });

  it('pushes a history entry when a file is opened from the gallery', () => {
    expect(
      getDetailUrlSyncAction({
        urlFileId: undefined,
        previousUrlFileId: undefined,
        selectedFileId: 'a'
      })
    ).toEqual({ type: 'mirror-url', fileId: 'a', mode: 'push' });
  });

  // Regression: navigating between files used to be able to land on a replace
  // of the gallery's own entry, which left two consecutive entries pointing at
  // the same file — the browser back button then never left the detail view.
  it('replaces, not pushes, when moving between files', () => {
    expect(
      getDetailUrlSyncAction({
        urlFileId: 'a',
        previousUrlFileId: 'a',
        selectedFileId: 'b'
      })
    ).toEqual({ type: 'mirror-url', fileId: 'b', mode: 'replace' });
  });

  it('clears the URL when the selection is dropped locally', () => {
    expect(
      getDetailUrlSyncAction({
        urlFileId: 'a',
        previousUrlFileId: 'a',
        selectedFileId: undefined
      })
    ).toEqual({ type: 'clear-url' });
  });

  it('does nothing once both sides agree', () => {
    expect(
      getDetailUrlSyncAction({
        urlFileId: 'a',
        previousUrlFileId: 'a',
        selectedFileId: 'a'
      })
    ).toEqual({ type: 'none' });
    expect(
      getDetailUrlSyncAction({
        urlFileId: undefined,
        previousUrlFileId: undefined,
        selectedFileId: undefined
      })
    ).toEqual({ type: 'none' });
  });

  // Regression: entering fullscreen pushes an entry, swiping inside it
  // replaces that entry only, so the one underneath still names the file
  // fullscreen started on. Popping back to it used to drag the view there.
  it('keeps the swiped-to file when leaving fullscreen restores a stale id', () => {
    expect(
      getDetailUrlSyncAction({
        urlFileId: 'a',
        previousUrlFileId: 'c',
        selectedFileId: 'c',
        exitedFullscreen: true
      })
    ).toEqual({ type: 'mirror-url', fileId: 'c', mode: 'replace' });
  });

  it('still closes on a back that leaves the detail view entirely', () => {
    expect(
      getDetailUrlSyncAction({
        urlFileId: undefined,
        previousUrlFileId: 'c',
        selectedFileId: 'c',
        exitedFullscreen: true
      })
    ).toEqual({ type: 'close' });
  });

  it('does nothing when a URL change already matches the selection', () => {
    expect(
      getDetailUrlSyncAction({
        urlFileId: 'b',
        previousUrlFileId: 'a',
        selectedFileId: 'b'
      })
    ).toEqual({ type: 'none' });
  });
});
