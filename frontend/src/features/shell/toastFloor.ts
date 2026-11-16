/** Fixed controls along the bottom of the screen, and the menu that opens above them, that a toast must not cover. */
const FLOOR =
  '.search-lens, .search-lens-actions, .search-panel, .phone-actions, .more-actions-menu';

/** A toast keeps at least this much of the screen above it, so a tall panel cannot push it off the top. */
const MIN_ROOM_PX = 160;

/** The toasts' column: sonner's list and the repair notice that sits where the toasts start. */
const TOASTS = '[data-sonner-toaster], .library-repair-notice';

/**
 * Where sonner puts its list before the first toast exists (components/ui/sonner.tsx: bottom-left,
 * sonner 2's defaults): 356px wide, 24px from the edge, and the whole width up to 600px.
 */
const sonnerColumn = (width: number) =>
  width <= 600 ? { left: 0, right: width } : { left: 24, right: 24 + 356 };

/**
 * How much of the bottom of the screen the controls in FLOOR take, in pixels. Only controls under
 * the toasts' column count: a toast on the left of a wide window stays low beside the buttons on
 * the right.
 */
export function measureToastFloor(): number {
  const height = window.innerHeight;
  const shown = [...document.querySelectorAll(TOASTS)]
    .map((element) => element.getBoundingClientRect())
    .filter((box) => box.width > 0);
  // Measured from the first toast, so it does not land high and then drop a frame later.
  const columns = shown.length ? shown : [sonnerColumn(window.innerWidth)];
  let floor = 0;
  for (const element of document.querySelectorAll(FLOOR)) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (!columns.some((column) => box.left < column.right && box.right > column.left)) continue;
    floor = Math.max(floor, height - box.top);
  }
  return Math.min(floor, Math.max(0, height - MIN_ROOM_PX));
}

/**
 * Keeps `--toast-floor` on the root at the height the bottom controls take, so the toasts
 * (app.css, `--toast-offset-bottom`) sit just above whatever is on screen. Returns the cleanup.
 */
export function listenForToastFloor(): () => void {
  const root = document.documentElement;
  let frame = 0;
  const update = () => {
    frame = 0;
    root.style.setProperty('--toast-floor', `${measureToastFloor()}px`);
  };
  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };

  // Controls appear, open and close by a class or a mounted element, then slide into place.
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'data-state']
  });
  const events = ['transitionend', 'animationend'] as const;
  for (const name of events) document.addEventListener(name, schedule, true);
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  update();

  return () => {
    observer.disconnect();
    for (const name of events) document.removeEventListener(name, schedule, true);
    window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.cancelAnimationFrame(frame);
    root.style.removeProperty('--toast-floor');
  };
}
