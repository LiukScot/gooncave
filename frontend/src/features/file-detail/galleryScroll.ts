/**
 * Compute the gallery scroll offset to remember when a file is opened.
 *
 * Capture the live scroll position only on the initial gallery → detail open.
 * While a file is already open the window is pinned to the top of the detail
 * view, so re-capturing during prev/next navigation would clobber the real
 * position with 0 and send the user back to the top of the gallery on close.
 */
export const nextSavedGalleryScroll = (input: {
  hasOpenFile: boolean;
  currentScroll: number;
  savedScroll: number;
}): number => (input.hasOpenFile ? input.savedScroll : input.currentScroll);
