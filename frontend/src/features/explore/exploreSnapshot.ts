import type { SiteStream } from './mergeStream';

import type {
  ExplorePost,
  ExploreSiteError,
  ExploreSort,
  ExploreWindow
} from '@/api';

/**
 * What explore looked like when the reader last left it.
 *
 * Leaving the page unmounts the view, and its results live in component
 * state, so without this a trip to the gallery and back costs the whole list
 * — and with it the place the reader had scrolled to, which is the part they
 * actually notice. Restoring the scroll alone would be meaningless: there
 * has to be a list under it to scroll through.
 *
 * A module-level value rather than a store: nothing renders off it. It is
 * read once when the view mounts and written once when it goes away, and it
 * deliberately does not survive a reload — a fresh page is a fresh search.
 */

/** Everything that decides what explore searches for. */
export type ExploreQuery = {
  tagInput: string;
  tagQuery: string;
  sort: ExploreSort;
  popularWindow: ExploreWindow;
  popularDate: string;
  disabledSiteIds: string[];
};

export type ExploreSnapshot = {
  /**
   * The search these results answer. Rebuilt on the way back in and
   * compared, so results can never be shown under a different search.
   */
  key: string;
  /**
   * Restored before the first search runs, so the key matches on arrival.
   * The search box and the sort come back with the results: the right
   * scroll offset of the wrong search would be worse than nothing.
   */
  query: ExploreQuery;
  posts: ExplorePost[];
  siteErrors: ExploreSiteError[];
  hasMore: boolean;
  /** Where each site had got to, so Load more carries on where it stopped. */
  streams: Map<string, SiteStream>;
  /** Posts already offered, so a resumed search shows none of them twice. */
  seen: { keys: Set<string>; hashes: Set<string> };
  scrollY: number;
};

let snapshot: ExploreSnapshot | null = null;

export const writeExploreSnapshot = (next: ExploreSnapshot): void => {
  snapshot = next;
};

/** The stored results, but only when they answer the search being opened. */
export const readExploreSnapshot = (key: string): ExploreSnapshot | null =>
  snapshot?.key === key ? snapshot : null;

/** The search a mounting view should open on, when there is one to resume. */
export const readExploreQuery = (): ExploreQuery | null =>
  snapshot?.query ?? null;
