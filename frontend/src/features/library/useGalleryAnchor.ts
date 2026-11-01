import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

import type { GalleryStack } from './galleryDuplicateStacks';

import { GALLERY_SCROLL_KEY, seedListPlace } from '@/features/shell/windowScroll';

// Pages are asked for one at a time until the file turns up, so a file the new
// list holds very deep, or in another order, must not load the whole library.
const MAX_SEARCHED_FILES = 5000;

export type GalleryAnchor = {
  /** The file the reader was on, then the ones after it, in the old order. */
  after: string[];
  /** The ones before it, nearest first: used when nothing after it is left. */
  before: string[];
  viewportTop: number;
};

const memberIds = (stacks: GalleryStack[]) =>
  stacks.flatMap((stack) => stack.members.map((member) => member.id));

/**
 * Where the reader is: the file they have open, or the first tile on screen.
 * A reader still on the first row with no file open has no anchor: they stay at the top.
 */
export const takeGalleryAnchor = (
  stacks: GalleryStack[],
  items: VirtualItem[],
  measurements: VirtualItem[],
  offset: number,
  scrollMargin: number,
  openFileId: string | null
): GalleryAnchor | null => {
  const opened = openFileId === null ? -1 : findAnchorTile(stacks, [openFileId]);
  if (opened < 0 && offset <= scrollMargin) return null;
  const item =
    measurements[opened] ??
    items.find((candidate) => candidate.start >= offset) ??
    items.find((candidate) => candidate.end > offset);
  if (!item) return null;
  return {
    after: memberIds(stacks.slice(item.index)),
    before: memberIds(stacks.slice(0, item.index).reverse()),
    // A file reached by swiping may be far from where the list was left.
    viewportTop: opened < 0 ? item.start - offset : Math.max(0, Math.min(item.start - offset, window.innerHeight / 2))
  };
};

/** The tile holding the first of `ids` that this list has, or -1. */
export const findAnchorTile = (stacks: GalleryStack[], ids: string[]): number => {
  const tileByFile = new Map(
    stacks.flatMap((stack, index) => stack.members.map((member) => [member.id, index] as const))
  );
  for (const id of ids) {
    const tile = tileByFile.get(id);
    if (tile !== undefined) return tile;
  }
  return -1;
};

/**
 * Keeps the reader on the same file when the list changes between all files
 * and the ones on this device. `location` is the list asked for, `filesLocation`
 * the one `stacks` holds, which keeps the old list until the new one arrives.
 */
export function useGalleryAnchor({
  virtualizer,
  stacks,
  scrollMargin,
  openFileId,
  location,
  filesLocation,
  hasMore,
  onLoadMore,
  masonryElement
}: {
  virtualizer: Virtualizer<Window, Element>;
  stacks: GalleryStack[];
  scrollMargin: number;
  openFileId: string | null;
  location: string | undefined;
  filesLocation: string | undefined;
  hasMore: boolean;
  onLoadMore: (() => void) | undefined;
  masonryElement: RefObject<HTMLDivElement | null>;
}) {
  const anchor = useRef<GalleryAnchor | null>(null);
  const lastLocation = useRef(location);

  useLayoutEffect(() => {
    if (lastLocation.current === location) return;
    lastLocation.current = location;
    anchor.current ??= takeGalleryAnchor(
      stacks,
      virtualizer.getVirtualItems(),
      virtualizer.measurementsCache,
      virtualizer.scrollOffset ?? 0,
      scrollMargin,
      openFileId
    );
    // Only the change of location reads the list and its offset, as they were before it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  useLayoutEffect(() => {
    const place = anchor.current;
    if (!place || filesLocation !== location) return;
    const tile = findAnchorTile(stacks, place.after);
    if (tile < 0 && hasMore && onLoadMore && stacks.length < MAX_SEARCHED_FILES) {
      onLoadMore();
      return;
    }
    anchor.current = null;
    const found = tile >= 0 ? tile : findAnchorTile(stacks, place.before);
    const start = virtualizer.measurementsCache[found]?.start;
    if (start !== undefined) seedListPlace(GALLERY_SCROLL_KEY, start - place.viewportTop);
    // The virtualizer is stable, and its measurements follow `stacks` in the same render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stacks, location, filesLocation, hasMore]);

  // A reader who scrolls during the search has chosen where to be.
  useEffect(() => {
    const cancel = () => {
      if (masonryElement.current?.getClientRects().length) anchor.current = null;
    };
    window.addEventListener('wheel', cancel, { passive: true });
    window.addEventListener('touchstart', cancel, { passive: true });
    return () => {
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchstart', cancel);
    };
  }, [masonryElement]);
}
