/** Ignores router and restoration scrolls until this list receives user input. */
export const listenToUserScroll = (onScroll: (scrollY: number) => void) => {
  let userScrolled = false;
  const arm = () => {
    userScrolled = true;
  };
  const disarm = () => {
    userScrolled = false;
  };
  const armScrollbarDrag = (event: PointerEvent) => {
    const width = document.documentElement.clientWidth;
    if (width > 0 && event.clientX >= width) arm();
  };
  const armScrollKey = (event: KeyboardEvent) => {
    if (
      ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) &&
      !(event.target instanceof HTMLElement &&
        event.target.closest('input, textarea, select, [contenteditable]'))
    ) arm();
    else disarm();
  };
  const record = () => {
    if (userScrolled) onScroll(window.scrollY);
  };
  window.addEventListener('pointerdown', armScrollbarDrag, { passive: true });
  window.addEventListener('touchstart', arm, { passive: true });
  window.addEventListener('wheel', arm, { passive: true });
  window.addEventListener('keydown', armScrollKey);
  window.addEventListener('click', disarm, true);
  window.addEventListener('popstate', disarm);
  window.addEventListener('scroll', record, { passive: true });
  return () => {
    window.removeEventListener('pointerdown', armScrollbarDrag);
    window.removeEventListener('touchstart', arm);
    window.removeEventListener('wheel', arm);
    window.removeEventListener('keydown', armScrollKey);
    window.removeEventListener('click', disarm, true);
    window.removeEventListener('popstate', disarm);
    window.removeEventListener('scroll', record);
  };
};
