import { useLayoutEffect } from 'react';

import { listenToUserScroll } from '@/features/file-detail/listenToUserScroll';
import {
  anchoredScrollTarget,
  restoreScrollTo,
  type ScrollRestorePlace
} from '@/features/file-detail/restoreScrollTo';

/**
 * The only code that moves the window for the app's own pages.
 *
 * A page declares what it shows with `useWindowScrollScreen` from the
 * component that renders it, so a screen is "on screen" exactly while it is
 * rendered. A controller that outlives its page (the gallery's lives in the
 * app shell) cannot move the window from behind another page.
 *
 * - A detail starts at the top, and stays there while the router and the
 *   layout settle.
 * - A list goes back to its recorded place: the tile the reader opened, at
 *   the same height in the viewport, or the offset they last scrolled to.
 *   A list with no recorded place is left alone.
 *
 * Places are kept per list key for the session. A list whose items do not
 * survive its unmount (explore, a pool) forgets its place on unmount and
 * seeds it again when it restores its items from a snapshot.
 */
export type ScrollScreen =
  | { kind: 'detail'; key: string }
  | { kind: 'list'; key: string };

export const GALLERY_SCROLL_KEY = 'gallery';
export const EXPLORE_SCROLL_KEY = 'explore';
export const poolScrollKey = (siteId: string, poolId: string): string =>
  `pool:${siteId}:${poolId}`;

const places = new Map<string, ScrollRestorePlace>();
let activeList: { key: string; stopRestore: () => void } | null = null;

const anchorTop = (anchorId: string | null): number | null => {
  if (!anchorId) return null;
  const anchor = document.querySelector<HTMLElement>(
    `[data-detail-anchor=${JSON.stringify(anchorId)}]`
  );
  return anchor?.getBoundingClientRect().top ?? null;
};

const restoreListPlace = (key: string): (() => void) => {
  const place = places.get(key);
  if (!place) return () => undefined;
  return restoreScrollTo(() =>
    anchoredScrollTarget({
      savedScrollY: place.scrollY,
      savedViewportTop: place.viewportTop,
      currentScrollY: window.scrollY,
      currentViewportTop: anchorTop(place.anchorId)
    })
  );
};

/**
 * Records where a list is before a detail opens from it. `anchorId` is the
 * `data-detail-anchor` of the opened tile; the list comes back with that
 * tile at the same viewport height, which survives a masonry reflow.
 */
export const rememberListPlace = (key: string, anchorId?: string): void => {
  places.set(key, {
    scrollY: window.scrollY,
    anchorId: anchorId ?? null,
    viewportTop: anchorTop(anchorId ?? null)
  });
};

/**
 * The detail moved to another item: the list comes back to that item's tile,
 * at the height the opened tile had.
 */
export const moveListAnchor = (key: string, anchorId: string): void => {
  const place = places.get(key);
  if (place) places.set(key, { ...place, anchorId });
};

/**
 * Sets a list's place from a snapshot restored after a remount. Moves the
 * window only when that list is the screen shown; otherwise the list goes
 * there when it next comes on screen.
 */
export const seedListPlace = (key: string, scrollY: number): void => {
  places.set(key, { scrollY, anchorId: null, viewportTop: null });
  if (activeList?.key !== key) return;
  activeList.stopRestore();
  activeList.stopRestore = restoreListPlace(key);
};

/**
 * Hands over a list's offset for a snapshot written on unmount, and forgets
 * it: the place belongs to items that go with that mount.
 */
export const takeListScrollY = (key: string): number => {
  const scrollY = places.get(key)?.scrollY ?? 0;
  places.delete(key);
  return scrollY;
};

/**
 * Declares the screen this component renders. Pass null while it renders
 * none of its own (a transient state on the way to another page).
 */
export function useWindowScrollScreen(screen: ScrollScreen | null): void {
  const kind = screen?.kind ?? null;
  const key = screen?.key ?? null;
  useLayoutEffect(() => {
    if (kind === null || key === null) return;
    if (kind === 'detail') {
      // Synchronous as well as held: the detail's own layout effects
      // measure the page and must not see the list's offset.
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      return restoreScrollTo(0);
    }
    const list = { key, stopRestore: restoreListPlace(key) };
    activeList = list;
    const stopRecording = listenToUserScroll((scrollY) => {
      places.set(key, { scrollY, anchorId: null, viewportTop: null });
    });
    return () => {
      list.stopRestore();
      stopRecording();
      if (activeList === list) activeList = null;
    };
  }, [kind, key]);
}
