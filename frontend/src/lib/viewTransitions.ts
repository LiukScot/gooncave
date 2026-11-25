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
const MENU = '.app-menu';
const DETAIL_PICTURE = '.file-detail-panel-current .file-detail-media-wrap';
/**
 * Longest the copy of the page left may stay. A window the compositor is not
 * drawing never advances its animations, and the copy would cover the page.
 */
const STALL_MS = 1500;

let finishRunning: (() => void) | null = null;

/**
 * A still copy of what `page` shows, fixed where it shows now and as tall as
 * the window, with the side menu beside it. Its videos load nothing: the copy
 * only stands in for the page a moment.
 */
const copyInPlace = (page: HTMLElement): HTMLElement => {
  const box = page.getBoundingClientRect();
  const copy = page.cloneNode(true) as HTMLElement;
  // A hidden part (the grid under an open file) shows nothing and would only add a second copy of it.
  for (const hidden of copy.querySelectorAll('[hidden], .kept-under-detail')) hidden.remove();
  // A lazy, async picture of the copy is drawn a frame late: WebKit showed the page's background
  // alone, a black frame, before the copy's thumbnails.
  for (const picture of copy.querySelectorAll('img')) {
    picture.loading = 'eager';
    picture.decoding = 'sync';
  }
  for (const video of copy.querySelectorAll('video')) {
    video.removeAttribute('autoplay');
    video.preload = 'none';
  }
  // The page makes room for the menu through a rule on the menu beside it, which the copy is not.
  copy.style.padding = getComputedStyle(page).padding;
  const menu = document.querySelector(MENU);
  if (menu && getComputedStyle(menu).display !== 'none') copy.prepend(menu.cloneNode(true));
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

/**
 * Where the picture shows inside its box: the box runs the full width, and the
 * picture is centred in it at the file's own shape.
 */
const pictureBox = (wrap: Element): DOMRect => {
  const box = wrap.getBoundingClientRect();
  const [width, height = 1] = getComputedStyle(wrap)
    .getPropertyValue('--file-detail-aspect')
    .split('/')
    .map(Number);
  const aspect = width / height;
  if (!(aspect > 0)) return box;
  const fitWidth = Math.min(box.width, box.height * aspect);
  const fitHeight = fitWidth / aspect;
  return new DOMRect(
    box.left + (box.width - fitWidth) / 2,
    box.top + (box.height - fitHeight) / 2,
    fitWidth,
    fitHeight
  );
};

/**
 * Flies a copy of the tile's picture to where the file's picture lands, over
 * the page rising and in step with it. The file's own picture stays hidden
 * until then: inside the page it would fade in with it.
 */
const flyFromTile = (
  tile: HTMLImageElement,
  from: DOMRect,
  wrap: HTMLElement,
  to: DOMRect,
  rise: Animation
) => {
  const hero = tile.cloneNode() as HTMLImageElement;
  hero.removeAttribute('style');
  hero.className = 'page-hero';
  hero.alt = '';
  hero.loading = 'eager';
  hero.setAttribute('aria-hidden', 'true');
  document.body.append(hero);
  // An attribute, not a class: React rewrites the class when the picture loads.
  wrap.dataset.landing = '';
  const place = (box: DOMRect) => ({
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`
  });
  const effect = rise.effect as KeyframeEffect | null;
  const flight = hero.animate([place(from), place(to)], {
    duration: Number(effect?.getTiming().duration ?? 0),
    easing: effect?.getKeyframes()[0]?.easing ?? 'linear',
    fill: 'both'
  });
  const land = () => {
    hero.remove();
    delete wrap.dataset.landing;
  };
  return { flight, land };
};

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
  const tile = sharedSelector ? document.querySelector(sharedSelector) : null;
  // Measured while the grid still shows: the file opening hides it.
  const tileBox = tile?.getBoundingClientRect();
  const copy = copyInPlace(page);
  flushSync(update);
  const picture = type === 'detail-open' ? page.querySelector<HTMLElement>(DETAIL_PICTURE) : null;
  // Measured before the page starts lower down to rise.
  const landing = picture && pictureBox(picture);
  const moving = type === 'detail-open' ? page : copy;
  moving.classList.add(type === 'detail-open' ? 'is-rising' : 'is-sinking');
  const animations = moving.getAnimations();
  let land = () => {};
  if (tile instanceof HTMLImageElement && tileBox && picture && landing && animations[0]) {
    const hero = flyFromTile(tile, tileBox, picture, landing, animations[0]);
    animations.push(hero.flight);
    land = hero.land;
  }
  let stall = 0;
  const finish = () => {
    if (finishRunning !== finish) return;
    finishRunning = null;
    window.clearTimeout(stall);
    copy.remove();
    land();
    page.classList.remove('is-rising');
    for (const animation of animations) animation.cancel();
  };
  finishRunning = finish;
  stall = window.setTimeout(finish, STALL_MS);
  void Promise.all(animations.map((animation) => animation.finished)).then(finish, finish);
};
