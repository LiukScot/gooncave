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

type TabLocation = { pathname: string; search: object };

// A detail view is open on this location: a gallery file or an explore post.
const hasDetail = ({ search }: TabLocation): boolean => {
  const { fileId, post } = search as { fileId?: string; post?: string };
  return Boolean(fileId ?? post);
};

const SETTINGS_ROUTE = '/app/settings';

const settingsDepth = (pathname: string): number =>
  pathname.replace(/\/$/, '') === SETTINGS_ROUTE ? 0 : 1;

/**
 * Inside Settings, opening one of its pages is a push and leaving it a pop:
 * iOS's navigation, which only the Apple Edition animates (app.css).
 */
const sectionTransitionTypes = (
  fromLocation: TabLocation,
  toLocation: TabLocation
): string[] | false => {
  if (!toLocation.pathname.startsWith(SETTINGS_ROUTE)) return false;
  const from = settingsDepth(fromLocation.pathname);
  const to = settingsDepth(toLocation.pathname);
  if (from === to) return false;
  return [to > from ? 'push' : 'pop'];
};

/**
 * The slide for a navigation between two views, a push or pop between
 * Settings and one of its pages, or `false` for every other navigation:
 * the URL also changes for filters and for the open file, and none of
 * those is a change of page.
 *
 * A detail view on either side is not a change of page either. Stepping
 * through a pool from a gallery file opens the next post in explore, which
 * crosses two views without the reader having switched view.
 */
export const tabTransitionTypes = (
  fromLocation: TabLocation | undefined,
  toLocation: TabLocation
): string[] | false => {
  if (!fromLocation || hasDetail(fromLocation) || hasDetail(toLocation)) {
    return false;
  }
  const from = tabIndexOf(fromLocation.pathname);
  const to = tabIndexOf(toLocation.pathname);
  if (from === -1 || to === -1) return false;
  if (from === to) return sectionTransitionTypes(fromLocation, toLocation);
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
