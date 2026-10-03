import { flushSync } from 'react-dom';

/**
 * Page-to-page animation through the browser's View Transitions: it takes a
 * picture of the page before a change and one after, and animates between
 * the two. Each transition carries a type, which is what the rules in
 * app.css key on. A browser without typed transitions changes page at once.
 */
export const supportsViewTransitions =
  typeof document !== 'undefined' &&
  'startViewTransition' in document &&
  typeof CSS !== 'undefined' &&
  CSS.supports('selector(:active-view-transition-type(a))');

// The views in the order the view switcher shows them (see AppTabBar), which
// is the order the pages slide in.
const TAB_ROUTES = [
  '/app/explore',
  '/app/gallery',
  '/app/games',
  '/app/settings'
];

const tabIndexOf = (pathname: string): number =>
  TAB_ROUTES.findIndex((route) => pathname.startsWith(route));

/**
 * The slide for a navigation between two views, or `false` for every other
 * navigation: the URL also changes for filters and for the open file, and
 * none of those is a change of page.
 */
export const tabTransitionTypes = (
  fromPathname: string | undefined,
  toPathname: string
): string[] | false => {
  const from = fromPathname === undefined ? -1 : tabIndexOf(fromPathname);
  const to = tabIndexOf(toPathname);
  if (from === -1 || to === -1 || from === to) return false;
  return [to > from ? 'tab-forward' : 'tab-back'];
};

// The name the detail picture carries in app.css. The gallery tile it opens
// from borrows it until the detail is on the page.
const SHARED_NAME = 'detail-media';

/** The picture of a file's tile in the gallery grid. */
export const galleryTileImage = (fileId: string): string =>
  `.gallery-thumb[data-file-id=${JSON.stringify(fileId)}] img`;

/**
 * Runs a React state change as a view transition of the given type.
 * `sharedSelector` finds the element, in the page as it is now, that grows
 * into the detail picture.
 */
export const transitionView = (
  type: string,
  update: () => void,
  sharedSelector?: string
): void => {
  if (!supportsViewTransitions) {
    update();
    return;
  }
  const shared = sharedSelector
    ? document.querySelector<HTMLElement>(sharedSelector)
    : null;
  if (shared) shared.style.viewTransitionName = SHARED_NAME;
  // lib.dom.ts has no typed variant of startViewTransition yet.
  const transition = (
    document as unknown as {
      startViewTransition: (options: {
        update: () => void;
        types: string[];
      }) => ViewTransition;
    }
  ).startViewTransition({
    update: () => {
      flushSync(update);
      if (shared) shared.style.viewTransitionName = '';
    },
    types: [type]
  });
  // A skipped transition rejects `ready`; the change itself still happened.
  transition.ready.catch(() => undefined);
};
