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
  selectedFileId
}: DetailUrlSyncInput): DetailUrlSyncAction => {
  const urlMoved = urlFileId !== previousUrlFileId;

  if (urlMoved) {
    if (!urlFileId) {
      return selectedFileId ? { type: 'close' } : { type: 'none' };
    }
    return urlFileId === selectedFileId
      ? { type: 'none' }
      : { type: 'open', fileId: urlFileId };
  }

  if (selectedFileId === urlFileId) return { type: 'none' };
  if (!selectedFileId) return { type: 'clear-url' };
  return {
    type: 'mirror-url',
    fileId: selectedFileId,
    mode: urlFileId ? 'replace' : 'push'
  };
};
