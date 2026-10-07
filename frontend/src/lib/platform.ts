/**
 * iPhone and iPad, including an iPad that reports itself as a Mac. Their
 * native video bar is the one to use: it is what the system draws over ours.
 */
export const isIos = (): boolean =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
