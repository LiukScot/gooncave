import { useRouterState } from '@tanstack/react-router';

import type { ExploreFeed } from '@/api';

const NO_SEARCH = {};

/**
 * The location of the page on screen. `useLocation` moves as soon as a
 * navigation starts, before the view transition has pictured the old page, so
 * anything visible that follows it would already show the new page in the
 * picture of the old one.
 */
export function useShownLocation() {
  const pathname = useRouterState({
    select: (state) => state.matches.at(-1)?.pathname ?? ''
  });
  const search = useRouterState({
    select: (state) => state.matches.at(-1)?.search ?? NO_SEARCH
  }) as { feed?: ExploreFeed };
  return { pathname, search };
}
