/**
 * The gallery detail view lives in two places: the `fileId` search param and
 * the controller's `selectedFile` state. Keeping both in sync used to be split
 * across several effects, and because effects in one commit all observe the
 * pre-update state, a browser back would clear the selection in one effect
 * while another still saw the old selection and wrote the file back into the
 * URL — so back never left the detail view.
 *
 * This decides the single action to take per pass. The rule: whichever side
 * moved since the last pass wins, and only the *other* side is touched, so a
 * change can never bounce back.
 */
export type DetailUrlSyncInput = {
  urlFileId?: string;
  previousUrlFileId?: string;
  selectedFileId?: string;
  /**
   * True on the pass where the `fs` flag just went away. Swiping inside
   * fullscreen replaces the top history entry, so the entry underneath still
   * names the file fullscreen was entered on; popping back to it would drag
   * the view to that stale file.
   */
  exitedFullscreen?: boolean;
};

export type DetailUrlSyncAction =
  /** URL gained a file (link, forward, direct load) — open it. */
  | { type: 'open'; fileId: string }
  /** URL lost its file (back button) — drop the selection. */
  | { type: 'close' }
  /**
   * Selection moved locally — mirror it into the URL. `push` when entering the
   * detail view (so back returns to the gallery), `replace` when moving
   * between files (so back does not have to walk every file visited).
   */
  | { type: 'mirror-url'; fileId: string; mode: 'push' | 'replace' }
  /** Selection was cleared locally — drop the file from the URL. */
  | { type: 'clear-url' }
  | { type: 'none' };

export const getDetailUrlSyncAction = ({
  urlFileId,
  previousUrlFileId,
  selectedFileId,
  exitedFullscreen
}: DetailUrlSyncInput): DetailUrlSyncAction => {
  const urlMoved = urlFileId !== previousUrlFileId;

  if (urlMoved) {
    if (!urlFileId) {
      return selectedFileId ? { type: 'close' } : { type: 'none' };
    }
    if (urlFileId === selectedFileId) return { type: 'none' };
    // Leaving fullscreen is the one case where the URL moved but must not
    // win: the file on screen is the one the user swiped to, and the stale
    // id the pop restored gets written back over instead.
    if (exitedFullscreen && selectedFileId) {
      return { type: 'mirror-url', fileId: selectedFileId, mode: 'replace' };
    }
    return { type: 'open', fileId: urlFileId };
  }

  if (selectedFileId === urlFileId) return { type: 'none' };
  if (!selectedFileId) return { type: 'clear-url' };
  return {
    type: 'mirror-url',
    fileId: selectedFileId,
    mode: urlFileId ? 'replace' : 'push'
  };
};
