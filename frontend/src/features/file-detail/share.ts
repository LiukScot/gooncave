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
