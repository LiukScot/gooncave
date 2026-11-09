import { api, type ShareAnchor } from '@/api';

/**
 * True when the browser can put a *file* in the share sheet (Web Share
 * Level 2). Browsers that only share text and URLs still expose
 * `navigator.share`, so the probe has to carry a real file: `canShare`
 * inspects the payload, not just the key.
 *
 * The probe type is deliberately an image — every implementation that
 * supports file sharing at all accepts one, while exotic types are
 * rejected per-platform and would understate support.
 */
export const canShareFiles = (): boolean => {
  if (typeof navigator === 'undefined' || !navigator.canShare) return false;
  try {
    return navigator.canShare({
      files: [new File([], 'probe.png', { type: 'image/png' })]
    });
  } catch {
    // Some engines throw instead of returning false on an unsupported
    // payload. Either way the answer is "no file sharing here".
    return false;
  }
};

let pressed: Element | null = null;
if (typeof document !== 'undefined') {
  // Every share button opens the sheet from a press; remembering it here spares each caller.
  document.addEventListener(
    'pointerdown',
    (event) => {
      pressed = event.target instanceof Element ? event.target.closest('button, a, [role="menuitem"]') : null;
    },
    { capture: true }
  );
}

/** The control just pressed, in page pixels: the app's share sheet grows out of it. */
export const shareAnchor = (): ShareAnchor | undefined => {
  if (!pressed?.isConnected) return undefined;
  const { x, y, width, height } = pressed.getBoundingClientRect();
  return { x, y, width, height };
};

/**
 * Hands a link to the share sheet, or copies it where there is none or the
 * sheet refuses it. Throws when copying fails too. `native` is the app's own
 * sheet (the `shareSheet` capability): the page's one opens on iPhone as a
 * small panel pinned to the button.
 */
export const shareLink = async (
  url: string,
  title: string,
  native = false
): Promise<'shared' | 'copied' | 'cancelled'> => {
  if (native) {
    try {
      return (await api.shareLinkNatively(url, shareAnchor())) ? 'shared' : 'cancelled';
    } catch (err) {
      console.error('[developer] The app share sheet refused a link; copying it instead', err);
    }
  } else if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, url });
      return 'shared';
    } catch (err) {
      // Closing the sheet is a choice, not a failure.
      if (err instanceof DOMException && err.name === 'AbortError') {
        return 'cancelled';
      }
      // Any other refusal falls through to copying.
    }
  }
  await navigator.clipboard.writeText(url);
  return 'copied';
};
