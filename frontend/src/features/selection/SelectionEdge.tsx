import { useLayoutEffect, useRef } from 'react';

type Side = 'left' | 'right' | 'top' | 'bottom';
type Box = Pick<DOMRect, Side>;

const FILL_MS = 300;
const SELECTED_TILE = '[data-select-key].is-selected';

/** The selected tiles beside `tile`, no more than `gap` apart, by side. */
const neighbours = (tile: Box, selected: Box[], gap: number) => {
  const near = (distance: number) => distance >= -1 && distance <= gap + 1;
  const beside: Record<Side, Box[]> = { left: [], right: [], top: [], bottom: [] };
  for (const other of selected) {
    const across = Math.min(tile.bottom, other.bottom) - Math.max(tile.top, other.top) > 0;
    const along = Math.min(tile.right, other.right) - Math.max(tile.left, other.left) > 0;
    if (across && near(tile.left - other.right)) beside.left.push(other);
    if (across && near(other.left - tile.right)) beside.right.push(other);
    if (along && near(tile.top - other.bottom)) beside.top.push(other);
    if (along && near(other.top - tile.bottom)) beside.bottom.push(other);
  }
  return beside;
};

/**
 * Where a tile's edge starts filling, or drains to, as -1, 0 or 1 on each
 * axis: towards the side with the most selected neighbours along it, or the
 * corner when the other axis has some too. `{0, 0}` without neighbours.
 */
export const fillOrigin = (tile: Box, selected: Box[], gap: number) => {
  const beside = neighbours(tile, selected, gap);
  const shared = (side: Side) =>
    beside[side].reduce((sum, other) =>
      sum + (side === 'left' || side === 'right'
        ? Math.min(tile.bottom, other.bottom) - Math.max(tile.top, other.top)
        : Math.min(tile.right, other.right) - Math.max(tile.left, other.left)), 0);
  const [left, right, top, bottom] = (['left', 'right', 'top', 'bottom'] as const).map(shared);
  const x = left > right ? -1 : right > 0 ? 1 : 0;
  const y = top > bottom ? -1 : bottom > 0 ? 1 : 0;
  return { x, y };
};

/**
 * Which corners of a tile's edge are square: those where a selected neighbour
 * reaches past the corner, so the colour runs on into the neighbour's
 * instead of leaving a curved notch between them.
 */
export const squareCorners = (tile: Box, selected: Box[], gap: number) => {
  const beside = neighbours(tile, selected, gap);
  const reaches = {
    top: (other: Box) => other.top <= tile.top + 1,
    bottom: (other: Box) => other.bottom >= tile.bottom - 1,
    left: (other: Box) => other.left <= tile.left + 1,
    right: (other: Box) => other.right >= tile.right - 1
  };
  const square = (vertical: 'top' | 'bottom', horizontal: 'left' | 'right') =>
    beside[horizontal].some(reaches[vertical]) || beside[vertical].some(reaches[horizontal]);
  return {
    topLeft: square('top', 'left'),
    topRight: square('top', 'right'),
    bottomRight: square('bottom', 'right'),
    bottomLeft: square('bottom', 'left')
  };
};

/** The colour gathered on the origin's side, or shrunk to the middle without one. */
const gathered = ({ x, y }: { x: number; y: number }) => {
  const [left, right] = x < 0 ? ['0', '100%'] : x > 0 ? ['100%', '0'] : y ? ['0', '0'] : ['50%', '50%'];
  const [top, bottom] = y < 0 ? ['0', '100%'] : y > 0 ? ['100%', '0'] : x ? ['0', '0'] : ['50%', '50%'];
  return `inset(${top} ${right} ${bottom} ${left})`;
};

const gridOf = (edge: Element) => {
  const grid = edge.closest<HTMLElement>('.gallery-masonry');
  const tile = edge.nextElementSibling;
  if (!grid || !tile) return null;
  return { grid, tile, gap: Number.parseFloat(getComputedStyle(grid).columnGap) || 0 };
};

const selectedBoxes = (grid: Element, except?: Element) =>
  [...grid.querySelectorAll(SELECTED_TILE)].filter((tile) => tile !== except).map((tile) => tile.getBoundingClientRect());

/** Squares the corners of every selected edge in `grid` against the current selection. */
const shapeEdges = (grid: HTMLElement, gap: number) => {
  const selected = selectedBoxes(grid);
  for (const edge of grid.querySelectorAll<HTMLElement>('.selection-edge.is-on')) {
    const tile = edge.nextElementSibling;
    if (!tile) continue;
    const corners = squareCorners(tile.getBoundingClientRect(), selected, gap);
    edge.style.borderTopLeftRadius = corners.topLeft ? '0' : '';
    edge.style.borderTopRightRadius = corners.topRight ? '0' : '';
    edge.style.borderBottomRightRadius = corners.bottomRight ? '0' : '';
    edge.style.borderBottomLeftRadius = corners.bottomLeft ? '0' : '';
  }
};

/**
 * The colour around a selected tile, across half the gap to the next one, so
 * selected neighbours join into one shape. It sits just before the tile, in
 * an element that does not clip it, and fills from, or drains to, the
 * selected tiles beside it.
 */
export function SelectionEdge({ selected }: { selected: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(selected);
  useLayoutEffect(() => {
    const edge = ref.current;
    const place = edge && gridOf(edge);
    if (!edge || !place) return;
    shapeEdges(place.grid, place.gap);
    if (shown.current === selected) return;
    shown.current = selected;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const origin = gathered(
      fillOrigin(place.tile.getBoundingClientRect(), selectedBoxes(place.grid, place.tile), place.gap)
    );
    const frames = selected
      ? [{ clipPath: origin }, { clipPath: 'inset(0)' }]
      : [
          { clipPath: 'inset(0)', visibility: 'visible' },
          { clipPath: origin, visibility: 'visible' }
        ];
    for (const running of edge.getAnimations()) running.cancel();
    edge.animate(frames, { duration: FILL_MS, easing: 'cubic-bezier(0.3, 0.7, 0.2, 1)' });
  }, [selected]);
  return <span ref={ref} className={`selection-edge${selected ? ' is-on' : ''}`} aria-hidden="true" />;
}
