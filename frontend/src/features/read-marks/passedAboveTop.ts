/**
 * Whether this card has left the observer's root past its top edge — the
 * difference between "scrolled well past" and "not reached yet".
 *
 * The observer grows its root upward by a couple of rows, so a card stays
 * inside the root until it is that far above the real viewport. Leaving
 * through the top of that grown root is what "the reader moved on" means.
 *
 * A null `rootBounds` (cross-origin frame) says nothing either way, and
 * guessing would mark a whole screen at once.
 */
export const passedAboveTop = (entry: IntersectionObserverEntry): boolean =>
  !entry.isIntersecting &&
  entry.rootBounds !== null &&
  entry.boundingClientRect.bottom <= entry.rootBounds.top;
