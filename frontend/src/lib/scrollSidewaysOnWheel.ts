/**
 * A ref callback for a row that only scrolls sideways: a vertical mouse
 * wheel moves the row instead of the page while the row still has room to
 * go that way, and hands back to the page at either end. Trackpads, which
 * already scroll sideways, are left alone.
 *
 * React's own onWheel is passive and cannot stop the page scrolling as
 * well, hence a native listener.
 */
export const scrollSidewaysOnWheel = (row: HTMLElement | null) => {
  if (!row) return;
  const onWheel = (event: WheelEvent) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const end = row.scrollWidth - row.clientWidth;
    const atStart = event.deltaY < 0 && row.scrollLeft <= 0;
    const atEnd = event.deltaY > 0 && row.scrollLeft >= end - 1;
    if (end <= 0 || atStart || atEnd) return;
    event.preventDefault();
    row.scrollLeft += event.deltaY;
  };
  row.addEventListener('wheel', onWheel, { passive: false });
  return () => row.removeEventListener('wheel', onWheel);
};
