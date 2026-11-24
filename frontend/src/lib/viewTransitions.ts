import { flushSync } from 'react-dom';

/**
 * Whether the browser has typed View Transitions, which the swipe back from
 * the left edge (lib/edgeSwipeBack.ts) moves by hand.
 */
export const supportsViewTransitions =
  typeof document !== 'undefined' &&
  'startViewTransition' in document &&
  typeof CSS !== 'undefined' &&
  CSS.supports('selector(:active-view-transition-type(a))');

/** The picture of a file's tile in the gallery grid. */
export const galleryTileImage = (fileId: string): string =>
  `.gallery-thumb[data-file-id=${JSON.stringify(fileId)}] img`;

export type PageChange = 'detail-open' | 'detail-close';

const PAGE = '.page-shell';
const DETAIL_PICTURE = '.file-detail-panel-current .file-detail-media-wrap';
/**
 * Longest the copy of the page left may stay. A window the compositor is not
 * drawing never advances its animations, and the copy would cover the page.
 */
const STALL_MS = 1500;

let finishRunning: (() => void) | null = null;

/**
 * A still copy of `page`, fixed where it shows now and as tall as the window.
 * Its videos load nothing: the copy only stands in for the page a moment.
 */
const copyInPlace = (page: HTMLElement): HTMLElement => {
  const box = page.getBoundingClientRect();
  const copy = page.cloneNode(true) as HTMLElement;
  for (const video of copy.querySelectorAll('video')) {
    video.removeAttribute('autoplay');
    video.preload = 'none';
  }
  copy.inert = true;
  copy.setAttribute('aria-hidden', 'true');
  copy.classList.add('page-leaving');
  copy.style.top = `${box.top}px`;
  copy.style.left = `${box.left}px`;
  copy.style.width = `${box.width}px`;
  copy.style.height = `${window.innerHeight - box.top}px`;
  document.body.append(copy);
  return copy;
};

/** Moves the detail picture from the tile's place to its own, in step with the page rising. */
const growFromTile = (picture: Element, tile: DOMRect, rise: Animation): Animation => {
  const to = picture.getBoundingClientRect();
  const scale = tile.width / to.width;
  const dx = tile.left + tile.width / 2 - (to.left + to.width / 2);
  const dy = tile.top + tile.height / 2 - (to.top + to.height / 2);
  const effect = rise.effect as KeyframeEffect | null;
  return picture.animate(
    [{ transform: `translate(${dx}px, ${dy}px) scale(${scale})` }, { transform: 'none' }],
    {
      duration: Number(effect?.getTiming().duration ?? 0),
      easing: effect?.getKeyframes()[0]?.easing ?? 'linear'
    }
  );
};

/**
 * Opens or closes a file with a React state change. Opening, the new page
 * rises over a copy of the one left and the picture grows out of the tile
 * that `sharedSelector` finds; closing, a copy of the file's page sinks away.
 * Copies, not the browser's View Transition pictures: under a fractional
 * display scale Chromium draws those white.
 */
export const transitionView = (
  type: PageChange,
  update: () => void,
  sharedSelector?: string
): void => {
  finishRunning?.();
  const page = document.querySelector<HTMLElement>(PAGE);
  if (!page || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  const tile = sharedSelector
    ? document.querySelector(sharedSelector)?.getBoundingClientRect()
    : undefined;
  const copy = copyInPlace(page);
  flushSync(update);
  const moving = type === 'detail-open' ? page : copy;
  moving.classList.add(type === 'detail-open' ? 'is-rising' : 'is-sinking');
  const animations = moving.getAnimations();
  const picture = page.querySelector(DETAIL_PICTURE);
  if (type === 'detail-open' && tile && picture && animations[0]) {
    animations.push(growFromTile(picture, tile, animations[0]));
  }
  let stall = 0;
  const finish = () => {
    if (finishRunning !== finish) return;
    finishRunning = null;
    window.clearTimeout(stall);
    copy.remove();
    page.classList.remove('is-rising');
    for (const animation of animations) animation.cancel();
  };
  finishRunning = finish;
  stall = window.setTimeout(finish, STALL_MS);
  void Promise.all(animations.map((animation) => animation.finished)).then(finish, finish);
};
