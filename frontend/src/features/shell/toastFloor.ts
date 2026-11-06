/** Fixed controls along the bottom of the screen, and the menu that opens above them, that a toast must not cover. */
const FLOOR =
  '.search-lens, .search-lens-actions, .search-panel, .phone-actions, .more-actions-menu';

/** A toast keeps at least this much of the screen above it, so a tall panel cannot push it off the top. */
const MIN_ROOM_PX = 160;

/** How much of the bottom of the screen the controls in FLOOR take, in pixels. */
export function measureToastFloor(): number {
  const height = window.innerHeight;
  let floor = 0;
  for (const element of document.querySelectorAll(FLOOR)) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
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
