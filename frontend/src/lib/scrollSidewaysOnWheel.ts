/**
 * Wheel events closer together than this belong to one gesture. Browsers
 * keep a nested scroll on the element where the gesture started for about as
 * long; kinetic trackpad scrolling sends events far more often.
 */
const GESTURE_GAP_MS = 500;

const rows = new Set<HTMLElement>();
let lastWheelAt = -Infinity;
let gestureRow: HTMLElement | null = null;

const trackGesture = (event: WheelEvent) => {
  const now = performance.now();
  if (now - lastWheelAt > GESTURE_GAP_MS) {
    const target = event.target instanceof Node ? event.target : null;
    gestureRow = [...rows].find((row) => target && row.contains(target)) ?? null;
  }
  lastWheelAt = now;
};

/** Firefox reports mouse wheels in lines; a line is about one text line high. */
const pixelsPer = (mode: number, row: HTMLElement) =>
  mode === WheelEvent.DOM_DELTA_LINE ? 16 : mode === WheelEvent.DOM_DELTA_PAGE ? row.clientWidth : 1;

/**
 * A ref callback for a row that only scrolls sideways: a vertical mouse
 * wheel moves the row instead of the page while the row still has room to
 * go that way, and hands back to the page at either end. Trackpads, which
 * already scroll sideways, are left alone. A page scroll that carries the
 * row under the pointer keeps scrolling the page. Card snapping waits until
 * the wheel stops.
 *
 * React's own onWheel is passive and cannot stop the page scrolling as
 * well, hence a native listener.
 */
export const scrollSidewaysOnWheel = (row: HTMLElement | null) => {
  if (!row) return;
  if (rows.size === 0) {
    window.addEventListener('wheel', trackGesture, { capture: true, passive: true });
  }
  rows.add(row);
  let resnap: ReturnType<typeof setTimeout> | undefined;
  const onWheel = (event: WheelEvent) => {
    // Ctrl+wheel and trackpad pinches zoom the page.
    if (gestureRow !== row || event.ctrlKey) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const end = row.scrollWidth - row.clientWidth;
    const atStart = event.deltaY < 0 && row.scrollLeft <= 0;
    const atEnd = event.deltaY > 0 && row.scrollLeft >= end - 1;
    if (end <= 0 || atStart || atEnd) return;
    event.preventDefault();
    // Snapping would pull each small step of a smooth wheel back to the same card.
    row.style.scrollSnapType = 'none';
    clearTimeout(resnap);
    resnap = setTimeout(() => {
      row.style.scrollSnapType = '';
    }, GESTURE_GAP_MS);
    row.scrollLeft += event.deltaY * pixelsPer(event.deltaMode, row);
  };
  row.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    clearTimeout(resnap);
    row.removeEventListener('wheel', onWheel);
    rows.delete(row);
    if (gestureRow === row) gestureRow = null;
    if (rows.size === 0) {
      window.removeEventListener('wheel', trackGesture, { capture: true });
    }
  };
};
