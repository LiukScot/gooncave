/** The buttons whose corners square off while pressed (app.css reads `data-pressed`). */
const PRESSABLE =
  '.btn, .file-detail-overlay-btn, .search-lens, .search-lens-action, .explore-action-btn, .explore-video-play, .video-controls-btn';

/**
 * How long a press keeps the squared corners at least. A quick click or tap
 * lasts well under 100 ms, and `:active` alone would undo the shape before it
 * shows.
 */
export const MIN_PRESS_MS = 200;

/** Marks the pressed button with `data-pressed` for at least MIN_PRESS_MS. Returns the cleanup. */
export function listenForPresses(): () => void {
  let pressed: { element: Element; at: number } | null = null;
  const timers = new Set<number>();

  const release = () => {
    const current = pressed;
    pressed = null;
    if (!current) return;
    const timer = window.setTimeout(
      () => {
        timers.delete(timer);
        current.element.removeAttribute('data-pressed');
      },
      Math.max(0, MIN_PRESS_MS - (performance.now() - current.at))
    );
    timers.add(timer);
  };
  const press = (event: PointerEvent) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const element = event.target.closest(PRESSABLE);
    if (!element || element.matches(':disabled')) return;
    release();
    element.setAttribute('data-pressed', '');
    pressed = { element, at: performance.now() };
  };

  window.addEventListener('pointerdown', press, true);
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  return () => {
    window.removeEventListener('pointerdown', press, true);
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointercancel', release, true);
    timers.forEach((timer) => window.clearTimeout(timer));
    pressed?.element.removeAttribute('data-pressed');
  };
}
