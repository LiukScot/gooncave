import { useEffect, useId, useLayoutEffect, useRef } from 'react';

type Side = 'left' | 'right' | 'top' | 'bottom';
type Box = Pick<DOMRect, Side>;
type Origin = { x: number; y: number };

const SVG = 'http://www.w3.org/2000/svg';
const FILL_MS = 300;
const EASING = 'cubic-bezier(0.3, 0.7, 0.2, 1)';

/**
 * Where a tile's colour flows in from, or drains to, as -1, 0 or 1 on each
 * axis: towards the side with the most selected neighbours along it, or the
 * corner when the other axis has some too. `{0, 0}` without neighbours.
 * Tiles count as neighbours when no more than `gap` apart.
 */
export const fillOrigin = (tile: Box, selected: Box[], gap: number): Origin => {
  const near = (distance: number) => distance >= -1 && distance <= gap + 1;
  const shared: Record<Side, number> = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const other of selected) {
    const across = Math.min(tile.bottom, other.bottom) - Math.max(tile.top, other.top);
    const along = Math.min(tile.right, other.right) - Math.max(tile.left, other.left);
    if (across > 0 && near(tile.left - other.right)) shared.left += across;
    if (across > 0 && near(other.left - tile.right)) shared.right += across;
    if (along > 0 && near(tile.top - other.bottom)) shared.top += along;
    if (along > 0 && near(other.top - tile.bottom)) shared.bottom += along;
  }
  const x = shared.left > shared.right ? -1 : shared.right > 0 ? 1 : 0;
  const y = shared.top > shared.bottom ? -1 : shared.bottom > 0 ? 1 : 0;
  return { x, y };
};

/**
 * Which corners of a selected tile's shape are square: those a selected
 * neighbour reaches past, so the colour runs on into the neighbour's instead
 * of leaving a curved notch between them.
 */
export const squareCorners = (tile: Box, selected: Box[], gap: number) => {
  const near = (distance: number) => distance >= -1 && distance <= gap + 1;
  const across = (other: Box) => Math.min(tile.bottom, other.bottom) - Math.max(tile.top, other.top) > 0;
  const along = (other: Box) => Math.min(tile.right, other.right) - Math.max(tile.left, other.left) > 0;
  const beside = {
    left: selected.filter((other) => across(other) && near(tile.left - other.right)),
    right: selected.filter((other) => across(other) && near(other.left - tile.right)),
    top: selected.filter((other) => along(other) && near(tile.top - other.bottom)),
    bottom: selected.filter((other) => along(other) && near(other.top - tile.bottom))
  };
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

/**
 * Rounded fillets for the inner corners where two selected tiles side by side
 * end at different heights, as `d` path strings. Each is centred where the
 * rounded outline of a tile in that corner would be, so it meets the cut
 * around a tile left out there, or rounds the corner off where none is.
 */
export const joins = (tiles: { box: Box; radius: number }[], gap: number) => {
  const half = gap / 2;
  const near = (distance: number) => distance >= -1 && distance <= gap + 1;
  const fillet = (x: number, y: number, dx: 1 | -1, dy: 1 | -1, room: number, radius: number) => {
    const r = Math.min(radius + half, room);
    return `M${x},${y}V${y + dy * r}A${r},${r} 0 0 ${dx * dy < 0 ? 0 : 1} ${x + dx * r},${y}Z`;
  };
  const paths: string[] = [];
  for (const a of tiles) {
    for (const b of tiles) {
      const [left, right] = [a.box, b.box];
      const across = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
      if (a === b || across <= 0 || !near(right.left - left.right)) continue;
      const radius = Math.min(a.radius, b.radius);
      const [inLeft, inRight] = [right.left - half, left.right + half];
      if (left.bottom < right.bottom - 1)
        paths.push(fillet(inLeft, left.bottom + half, -1, 1, Math.min(right.bottom - left.bottom, left.right - left.left), radius));
      if (right.bottom < left.bottom - 1)
        paths.push(fillet(inRight, right.bottom + half, 1, 1, Math.min(left.bottom - right.bottom, right.right - right.left), radius));
      if (left.top > right.top + 1)
        paths.push(fillet(inLeft, left.top - half, -1, -1, Math.min(left.top - right.top, left.right - left.left), radius));
      if (right.top > left.top + 1)
        paths.push(fillet(inRight, right.top - half, 1, -1, Math.min(right.top - left.top, right.right - right.left), radius));
    }
  }
  return paths;
};

/**
 * The shape gathered on the origin's side of `box`: a scale about that side, as a point in
 * the layer, so a tile's colour and the pieces it adds to its neighbours move as one.
 */
const gathered = (box: Box, { x, y }: Origin) => ({
  origin: `${x < 0 ? box.left : x > 0 ? box.right : (box.left + box.right) / 2}px ${y < 0 ? box.top : y > 0 ? box.bottom : (box.top + box.bottom) / 2}px`,
  transform: `scale(${x || !y ? 0 : 1}, ${y || !x ? 0 : 1})`
});

/** `box` grown by `grow` on every side, its corners rounded to the tile's own curve unless square. */
const outline = (box: Box, grow: number, radius: number, square = { topLeft: false, topRight: false, bottomRight: false, bottomLeft: false }) => {
  const [left, top, right, bottom] = [box.left - grow, box.top - grow, box.right + grow, box.bottom + grow];
  const r = Math.min(radius + grow, (right - left) / 2, (bottom - top) / 2);
  const [tl, tr, br, bl] = [square.topLeft, square.topRight, square.bottomRight, square.bottomLeft].map((on) => (on ? 0 : r));
  return [
    `M${left + tl},${top}`,
    `H${right - tr}`, tr ? `A${tr},${tr} 0 0 1 ${right},${top + tr}` : '',
    `V${bottom - br}`, br ? `A${br},${br} 0 0 1 ${right - br},${bottom}` : '',
    `H${left + bl}`, bl ? `A${bl},${bl} 0 0 1 ${left},${bottom - bl}` : '',
    `V${top + tl}`, tl ? `A${tl},${tl} 0 0 1 ${left + tl},${top}` : '',
    'Z'
  ].join('');
};

/**
 * The colour around the selected tiles of the grid it sits in: each selected
 * tile's outline reaches half a pixel past the middle of the gap, so selected
 * neighbours overlap into one shape, square where they meet, with rounded inner
 * corners. The gap of a tile left out is cut back to that tile's rounded
 * outline. A tile joining or leaving the selection flows in from, or drains
 * into, the selected tiles beside it.
 */
export function SelectionLayer({ selected }: { selected: ReadonlySet<string> }) {
  const id = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const shown = useRef<ReadonlySet<string>>(new Set(selected));
  const flows = useRef(new Map<string, { leaving: boolean; animation?: Animation }>());

  const draw = (changed: { added: string[]; removed: string[] }) => {
    const svg = svgRef.current;
    const grid = svg?.parentElement;
    if (!svg || !grid) return;
    const shapes = svg.querySelector<SVGGElement>('[data-part="shapes"]')!;
    const cuts = svg.querySelector<SVGGElement>('[data-part="cuts"]')!;
    const frame = grid.getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
    const tiles = new Map<string, { box: Box; radius: number }>();
    for (const tile of grid.querySelectorAll<HTMLElement>('[data-select-key]')) {
      const box = tile.getBoundingClientRect();
      tiles.set(tile.dataset.selectKey!, {
        box: { left: box.left - frame.left, right: box.right - frame.left, top: box.top - frame.top, bottom: box.bottom - frame.top },
        radius: Number.parseFloat(getComputedStyle(tile).borderTopLeftRadius) || 0
      });
    }
    svg.setAttribute('width', String(frame.width));
    svg.setAttribute('height', String(frame.height));
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // A tile leaving keeps its shape until it has drained away.
    if (!reduced) for (const key of changed.removed) if (tiles.has(key)) flows.current.set(key, { leaving: true });
    for (const key of changed.added) if (flows.current.get(key)?.leaving) flows.current.delete(key);
    const inShape = (key: string) => selected.has(key) || flows.current.get(key)?.leaving === true;
    const flowing = (key: string) => !reduced && (flows.current.has(key) || changed.added.includes(key));
    const grow = gap / 2 + 0.5;
    const settled = [...tiles].filter(([key]) => inShape(key) && !flowing(key));
    const boxes = (list: [string, { box: Box }][], except: string) => list.filter(([key]) => key !== except).map(([, tile]) => tile.box);
    const path = (d: string) => {
      const shape = document.createElementNS(SVG, 'path');
      shape.setAttribute('d', d);
      return shape;
    };
    const existing = new Map([...shapes.children].map((group) => [(group as SVGGElement).dataset.key!, group as SVGGElement]));
    for (const [key, group] of existing) if (!inShape(key) || !tiles.has(key)) group.remove();
    for (const [key, tile] of tiles) {
      if (!inShape(key)) continue;
      let group = existing.get(key);
      if (!group?.isConnected) {
        group = document.createElementNS(SVG, 'g');
        group.dataset.key = key;
        shapes.append(group);
      }
      if (!flowing(key)) {
        // Half a pixel past half the gap: selected neighbours overlap without a seam, while the
        // outer edge stays on the cut around tiles left out instead of stepping past it.
        group.replaceChildren(path(outline(tile.box, grow, tile.radius, squareCorners(tile.box, boxes(settled, key), gap))));
        continue;
      }
      // A tile flowing in or out carries what it changes around it: the corners of settled
      // neighbours it squares, and the rounded joins beside it. Drawn on the neighbours, they
      // would show before the tile's own colour reaches them.
      const others = [...tiles].filter(([other]) => other !== key && inShape(other));
      const pieces = [path(outline(tile.box, grow, tile.radius, squareCorners(tile.box, boxes(others, key), gap)))];
      for (const [other, neighbour] of settled) {
        const before = squareCorners(neighbour.box, boxes(settled, other), gap);
        const after = squareCorners(neighbour.box, [...boxes(settled, other), tile.box], gap);
        const [left, top, right, bottom] = [neighbour.box.left - grow, neighbour.box.top - grow, neighbour.box.right + grow, neighbour.box.bottom + grow];
        const r = Math.min(neighbour.radius + grow, (right - left) / 2, (bottom - top) / 2);
        const corners = { topLeft: [left, top], topRight: [right - r, top], bottomRight: [right - r, bottom - r], bottomLeft: [left, bottom - r] } as const;
        for (const corner of Object.keys(corners) as (keyof typeof corners)[]) {
          if (after[corner] && !before[corner]) pieces.push(path(`M${corners[corner][0]},${corners[corner][1]}h${r}v${r}h${-r}Z`));
        }
      }
      for (const [, other] of others) pieces.push(...joins([tile, other], gap).map(path));
      group.replaceChildren(...pieces);
      const joining = changed.added.includes(key);
      const leaving = changed.removed.includes(key);
      if (!joining && !leaving) continue;
      const end = gathered(
        { left: tile.box.left - grow, top: tile.box.top - grow, right: tile.box.right + grow, bottom: tile.box.bottom + grow },
        fillOrigin(tile.box, boxes(others, key), gap)
      );
      group.style.transformBox = 'view-box';
      group.style.transformOrigin = end.origin;
      for (const running of group.getAnimations()) running.cancel();
      const animation = group.animate(
        joining ? [{ transform: end.transform }, { transform: 'none' }] : [{ transform: 'none' }, { transform: end.transform }],
        { duration: FILL_MS, easing: EASING, fill: leaving ? 'forwards' : 'none' }
      );
      flows.current.set(key, { leaving, animation });
      const settle = () => {
        if (flows.current.get(key)?.animation !== animation) return;
        flows.current.delete(key);
        draw({ added: [], removed: [] });
      };
      // A cancelled flow was replaced by a newer one for the same tile, which settles instead.
      void animation.finished.then(settle, settle);
    }
    svg.querySelector('[data-part="joins"]')!.replaceChildren(...joins(settled.map(([, tile]) => tile), gap).map(path));
    // The gap of a tile left out follows that tile's rounded outline.
    cuts.replaceChildren(
      ...[...tiles].filter(([key]) => !inShape(key)).map(([, tile]) => path(outline(tile.box, gap / 2, tile.radius)))
    );
  };
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = new Set(selected);
    drawRef.current({
      added: [...selected].filter((key) => !before.has(key)),
      removed: [...before].filter((key) => !selected.has(key))
    });
  }, [selected]);

  // Tiles move, appear and go as the grid lays out, loads more and scrolls.
  useEffect(() => {
    const grid = svgRef.current?.parentElement;
    if (!grid) return;
    let frame = 0;
    const redraw = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => drawRef.current({ added: [], removed: [] }));
    };
    const svg = svgRef.current!;
    // The layer's own shapes change inside the grid too.
    const children = new MutationObserver((records) => {
      if (records.some((record) => !svg.contains(record.target))) redraw();
    });
    children.observe(grid, { childList: true, subtree: true });
    const size = new ResizeObserver(redraw);
    size.observe(grid);
    return () => {
      cancelAnimationFrame(frame);
      children.disconnect();
      size.disconnect();
    };
  }, []);

  const cutOut = `${id}-cut`;
  return (
    <svg ref={svgRef} className="selection-layer" aria-hidden="true">
      <defs>
        <mask id={cutOut} maskUnits="userSpaceOnUse" x="-100%" y="-100%" width="300%" height="300%">
          <rect x="-100%" y="-100%" width="300%" height="300%" fill="white" />
          <g data-part="cuts" fill="black" />
        </mask>
      </defs>
      <g mask={`url(#${cutOut})`}>
        <g data-part="shapes" />
        <g data-part="joins" />
      </g>
    </svg>
  );
}
