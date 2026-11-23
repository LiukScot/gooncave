import { useRouter } from '@tanstack/react-router';
import { useEffect, type RefObject } from 'react';

import { isSwipeBackRunning } from '@/lib/edgeSwipeBack';

type TabLocation = { pathname: string };

export type SlideDirection = 'push' | 'pop';

const SETTINGS_ROUTE = '/app/settings';
/**
 * Longest the copy of the page left may stay. A window the compositor is not
 * drawing never advances its animations, and the copy would cover the page.
 */
const STALL_MS = 1500;

const settingsDepth = (pathname: string): number =>
  pathname.replace(/\/$/, '') === SETTINGS_ROUTE ? 0 : 1;

/**
 * Inside Settings, opening one of its pages is a push and leaving it a pop:
 * iOS's navigation (app.css). Every other navigation changes the page at once:
 * the URL also changes for filters and for the open file.
 */
export const settingsSlideDirection = (
  fromLocation: TabLocation | undefined,
  toLocation: TabLocation
): SlideDirection | null => {
  if (
    !fromLocation?.pathname.startsWith(SETTINGS_ROUTE) ||
    !toLocation.pathname.startsWith(SETTINGS_ROUTE)
  ) {
    return null;
  }
  const from = settingsDepth(fromLocation.pathname);
  const to = settingsDepth(toLocation.pathname);
  if (from === to) return null;
  return to > from ? 'push' : 'pop';
};

/**
 * Slides Settings pages in and out. The page being left is a copy of its
 * elements put in `leavingRef`, not a view-transition picture: under a
 * fractional display scale Chromium draws that picture white. `stageRef`
 * holds `.settings-page`, the page the router shows, and the leaving copy.
 */
export function useSettingsSlide(
  stageRef: RefObject<HTMLElement | null>,
  leavingRef: RefObject<HTMLElement | null>
): void {
  const router = useRouter();

  useEffect(() => {
    let pending: SlideDirection | null = null;
    let stop = () => undefined as void;

    const currentPage = () =>
      stageRef.current?.querySelector<HTMLElement>(':scope > .settings-page') ?? null;

    const clear = () => {
      stop();
      stop = () => undefined;
      pending = null;
      const stage = stageRef.current;
      const page = currentPage();
      if (stage) delete stage.dataset.slide;
      if (page) page.style.minHeight = '';
      leavingRef.current?.replaceChildren();
    };

    const offBefore = router.subscribe('onBeforeNavigate', ({ fromLocation, toLocation }) => {
      clear();
      const direction = isSwipeBackRunning()
        ? null
        : settingsSlideDirection(fromLocation, toLocation);
      const stage = stageRef.current;
      const leaving = leavingRef.current;
      const page = currentPage();
      if (
        !direction ||
        !stage ||
        !leaving ||
        !page ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        return;
      }
      const stageBox = stage.getBoundingClientRect();
      const top = page.getBoundingClientRect().top;
      const copy = page.cloneNode(true) as HTMLElement;
      copy.inert = true;
      copy.style.top = `${top}px`;
      copy.style.minHeight = `${window.innerHeight - top}px`;
      leaving.style.left = `${stageBox.left}px`;
      leaving.style.width = `${stageBox.width}px`;
      leaving.replaceChildren(copy);
      pending = direction;
    });

    // Both pages start moving once the new one is on screen.
    const offRendered = router.subscribe('onRendered', () => {
      const direction = pending;
      const stage = stageRef.current;
      const page = currentPage();
      pending = null;
      if (!direction || !stage || !page) {
        clear();
        return;
      }
      // The new page covers the window to its bottom edge, or the page left
      // shows under it, without making the document any taller.
      const shell = stage.parentElement;
      const shellPadding = shell ? parseFloat(getComputedStyle(shell).paddingBottom) : 0;
      const top = page.getBoundingClientRect().top;
      page.style.minHeight = `${Math.max(0, document.documentElement.clientHeight - top - shellPadding)}px`;
      const settle = (event: AnimationEvent) => {
        if (event.target === page) clear();
      };
      page.addEventListener('animationend', settle);
      page.addEventListener('animationcancel', settle);
      const stall = window.setTimeout(clear, STALL_MS);
      stop = () => {
        window.clearTimeout(stall);
        page.removeEventListener('animationend', settle);
        page.removeEventListener('animationcancel', settle);
      };
      stage.dataset.slide = direction;
    });

    return () => {
      offBefore();
      offRendered();
      clear();
    };
  }, [router, stageRef, leavingRef]);
}
