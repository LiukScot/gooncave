/**
 * iPhone and iPad, including an iPad that reports itself as a Mac. Their
 * native video bar is the one to use: it is what the system draws over ours.
 */
export const isIos = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** The iPhone app says how round this screen's corners are before the page loads. */
export const applyScreenCorner = (): void => {
  const corner = (window as { gooncaveScreenCorner?: unknown }).gooncaveScreenCorner;
  if (typeof corner === 'number' && corner >= 0) {
    document.documentElement.style.setProperty('--screen-corner', `${corner}px`);
  }
};
