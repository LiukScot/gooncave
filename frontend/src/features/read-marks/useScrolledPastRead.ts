import { useEffect, useRef } from 'react';

import { passedAboveTop } from './passedAboveTop';
import { queueRead, type ReadScope } from './readQueue';

/** How far past a card the reader has to get before it counts as read. */
const ROWS_BEHIND = 2;
/** Used before the grid has laid out; matches the grid's minimum column width. */
const FALLBACK_ROW_HEIGHT = 220;

/**
 * The average height of one masonry row. Columns are packed to roughly equal
 * height, so the grid's own height divided by the cards per column is the row
 * height, whatever mix of tall and short tiles this page happens to hold.
 *
 * Taking a single card's height instead made the threshold jump between runs:
 * the first tile can be a portrait twice the height of the next one.
 */
export const averageRowHeight = (
  gridHeight: number,
  cardCount: number,
  columnCount: number
): number => {
  if (gridHeight <= 0 || cardCount <= 0 || columnCount <= 0) {
    return FALLBACK_ROW_HEIGHT;
  }
  return (gridHeight * columnCount) / cardCount;
};

/**
 * Whether a card that has left the root counts as read.
 *
 * `seenAtScrollY` is where the page stood when this card came into view. A
 * card only leaves through the top for two reasons: the reader scrolled down,
 * or the list around it got shorter and carried it up. Comparing against the
 * scroll position tells those apart — content moving under a stationary
 * reader leaves the position untouched.
 */
export const readerMovedPast = (
  seenAtScrollY: number | undefined,
  scrollY: number
): boolean => seenAtScrollY !== undefined && scrollY > seenAtScrollY;

/**
 * Marks cards read once the reader has passed two rows beyond them.
 *
 * Returns the ref to put on the masonry container. Cards inside it opt in with
 * a `data-read-key` attribute holding the key to mark.
 *
 * Two things make this "passed", not merely "is above the fold":
 *
 * - The observer's root is grown upward by ROWS_BEHIND rows, so a card stays
 *   inside it until it is that far above the viewport. Growing, never
 *   shrinking: a
 *   shrunken root marks cards still on screen, and a shrink taller than the
 *   viewport inverts the root and marks the whole page at once.
 * - A card is only eligible once this observer has reported it *inside* the
 *   root, and only if the page has scrolled since. An observer is born
 *   whenever the grid remounts or a page is appended, and it reports every
 *   card's current position — so returning to a restored scroll offset would
 *   otherwise mark everything above it, which the reader never scrolled past
 *   here. The scroll check covers the other half: switching the filter changes
 *   the list's length, and cards ride over the line on their own while the
 *   reader has not moved at all.
 *
 *   Eligibility deliberately waits for the observer's own report rather than
 *   measuring rects when watching starts: a grid remounts at scroll 0 and is
 *   restored to its old offset a moment later, and a rect read in between
 *   makes the whole restored page look scrolled past.
 */
export function useScrolledPastRead(
  scope: ReadScope,
  enabled: boolean,
  /** Re-scans for new cards when these change. */
  itemCount: number,
  columnCount: number
) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const markedRef = useRef(new Set<string>());
  /** Cards this mount has had in front of the reader, and where the page stood. */
  const inViewRef = useRef(new Map<string, number>());

  useEffect(() => {
    if (!enabled) {
      markedRef.current.clear();
      inViewRef.current.clear();
      return;
    }
    const grid = gridRef.current;
    if (!grid) return;
    const cards = [...grid.querySelectorAll<HTMLElement>('[data-read-key]')];
    if (!cards.length) return;

    const rowHeight = averageRowHeight(
      grid.getBoundingClientRect().height,
      cards.length,
      columnCount
    );
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.readKey;
          if (!key) continue;
          if (entry.isIntersecting) {
            // The root reaches ROWS_BEHIND rows above the viewport, so a card
            // can intersect it while sitting entirely off-screen. Only a card
            // that reached the visible area counts as seen.
            if (entry.boundingClientRect.bottom <= 0) continue;
            if (!inViewRef.current.has(key)) {
              inViewRef.current.set(key, window.scrollY);
            }
            continue;
          }
          // Still below the fold: it may yet come into view.
          if (!passedAboveTop(entry)) continue;
          if (!readerMovedPast(inViewRef.current.get(key), window.scrollY)) {
            // Left the root without the reader moving, so the list shifted
            // under them. Keep watching: they may still scroll past it.
            continue;
          }
          observer.unobserve(entry.target);
          inViewRef.current.delete(key);
          if (markedRef.current.has(key)) continue;
          markedRef.current.add(key);
          queueRead(scope, key);
        }
      },
      {
        root: null,
        threshold: 0,
        rootMargin: `${Math.round(ROWS_BEHIND * rowHeight)}px 0px 0px 0px`
      }
    );
    for (const card of cards) {
      // Appending page five must not re-walk pages one to four.
      if (markedRef.current.has(card.dataset.readKey ?? '')) continue;
      observer.observe(card);
    }
    return () => observer.disconnect();
  }, [columnCount, enabled, itemCount, scope]);

  return gridRef;
}
