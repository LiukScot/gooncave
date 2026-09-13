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

export const scrollViewToTop = (): void => {
  window.scrollTo({ top: 0 });
};

/** Keep modified clicks as links; a normal click on the active view goes up. */
export const handleViewReselect = (
  event: ViewReselectEvent,
  active: boolean
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
  scrollViewToTop();
};
