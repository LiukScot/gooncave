type ViewReselectEvent = Pick<
  MouseEvent,
  | 'altKey'
  | 'button'
  | 'ctrlKey'
  | 'defaultPrevented'
  | 'metaKey'
  | 'preventDefault'
  | 'shiftKey'
>;

// Long enough to read as a glide, short enough not to make anyone wait.
const GLIDE_MS = 500;
// The reader taking over (scrolling, touching, a key) ends the glide.
const TAKE_OVER_EVENTS = ['wheel', 'touchstart', 'keydown'] as const;

let glideFrame = 0;

/**
 * Glides back to the top, quick at first and easing into it; with Reduce
 * Motion on, or nowhere to go, it jumps. Driven frame by frame rather than
 * by `behavior: 'smooth'`, which some browsers ignore or drop.
 */
export const scrollViewToTop = (): void => {
  cancelAnimationFrame(glideFrame);
  const start = window.scrollY;
  const reduceMotion =
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (reduceMotion || start <= 0) {
    window.scrollTo({ top: 0 });
    return;
  }
  const stop = () => {
    cancelAnimationFrame(glideFrame);
    for (const type of TAKE_OVER_EVENTS) window.removeEventListener(type, stop);
  };
  for (const type of TAKE_OVER_EVENTS) {
    window.addEventListener(type, stop, { passive: true });
  }
  const startedAt = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / GLIDE_MS);
    const eased = 1 - (1 - progress) ** 3;
    window.scrollTo({ top: start * (1 - eased) });
    if (progress < 1) glideFrame = requestAnimationFrame(step);
    else stop();
  };
  glideFrame = requestAnimationFrame(step);
};

/**
 * Keep modified clicks as links; a normal click on the active view goes up,
 * after `onReselect` (the view's own reset, such as clearing its search).
 */
export const handleViewReselect = (
  event: ViewReselectEvent,
  active: boolean,
  onReselect?: () => void
): void => {
  if (
    !active ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return;
  }
  event.preventDefault();
  onReselect?.();
  scrollViewToTop();
};
