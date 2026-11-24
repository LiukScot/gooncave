import { Check } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';

type Side = 'left' | 'right' | 'top' | 'bottom';
type Box = Pick<DOMRect, Side>;

/**
 * Where a newly selected tile's edge starts filling, as -1, 0 or 1 on each
 * axis: towards the side with the most selected neighbours along it, or the
 * corner when the other axis has some too. `{0, 0}` without neighbours.
 * Tiles count as neighbours when no more than `gap` apart.
 */
export const fillOrigin = (tile: Box, selected: Box[], gap: number) => {
  const shared: Record<Side, number> = { left: 0, right: 0, top: 0, bottom: 0 };
  const near = (distance: number) => distance >= -1 && distance <= gap + 1;
  for (const other of selected) {
    const across = Math.min(tile.bottom, other.bottom) - Math.max(tile.top, other.top);
    const along = Math.min(tile.right, other.right) - Math.max(tile.left, other.left);
    if (across > 0 && near(tile.left - other.right)) shared.left += across;
    if (across > 0 && near(other.left - tile.right)) shared.right += across;
    if (along > 0 && near(tile.top - other.bottom)) shared.top += along;
    if (along > 0 && near(other.top - tile.bottom)) shared.bottom += along;
  }
  // Neighbours on two adjacent sides make the fill start from the corner between them.
  const x = shared.left > shared.right ? -1 : shared.right > 0 ? 1 : 0;
  const y = shared.top > shared.bottom ? -1 : shared.bottom > 0 ? 1 : 0;
  return { x, y };
};

/**
 * The check in the middle of a selected tile. Mounted when the tile is
 * selected, it points the tile's edge fill (`--fill-x`, `--fill-y` in
 * app.css) at the selected tiles already around it.
 */
export function SelectionCheck() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const tile = ref.current?.parentElement;
    const grid = tile?.closest('.gallery-masonry');
    if (!tile || !grid) return;
    const others = [...grid.querySelectorAll('[data-select-key].is-selected')]
      .filter((other) => other !== tile)
      .map((other) => other.getBoundingClientRect());
    const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
    const { x, y } = fillOrigin(tile.getBoundingClientRect(), others, gap);
    tile.style.setProperty('--fill-x', String(x));
    tile.style.setProperty('--fill-y', String(y));
  }, []);
  return (
    <span ref={ref} className="selection-check" aria-hidden="true">
      <Check />
    </span>
  );
}
