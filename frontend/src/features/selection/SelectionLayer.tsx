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

/** The shape gathered on the origin's side: a scale that keeps that side in place. */
const gathered = ({ x, y }: Origin) => ({
  origin: `${x < 0 ? 'left' : x > 0 ? 'right' : 'center'} ${y < 0 ? 'top' : y > 0 ? 'bottom' : 'center'}`,
  transform: `scale(${x || !y ? 0 : 1}, ${y || !x ? 0 : 1})`
});

const rounded = (rect: SVGRectElement, box: Box, grow: number, radius: number) => {
  rect.setAttribute('x', String(box.left - grow));
  rect.setAttribute('y', String(box.top - grow));
  rect.setAttribute('width', String(box.right - box.left + 2 * grow));
  rect.setAttribute('height', String(box.bottom - box.top + 2 * grow));
  rect.setAttribute('rx', String(radius + grow));
};

/**
 * The colour around the selected tiles of the grid it sits in, drawn as one
 * liquid shape: each selected tile's outline is blurred and cut back to a
 * sharp edge, so selected neighbours flow together across the gap with
 * rounded joins, while the gap of a tile left out keeps that tile's rounded
 * outline. A tile joining or leaving the selection flows in from, or drains
 * into, the selected tiles beside it.
 */
export function SelectionLayer({ selected }: { selected: ReadonlySet<string> }) {
  const id = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const shown = useRef<ReadonlySet<string>>(new Set(selected));
  const draining = useRef(new Set<string>());

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
    if (!reduced) for (const key of changed.removed) if (tiles.has(key)) draining.current.add(key);
    const inShape = (key: string) => selected.has(key) || draining.current.has(key);
    const existing = new Map(
      [...shapes.querySelectorAll<SVGRectElement>('rect')].map((rect) => [rect.dataset.key!, rect])
    );
    for (const [key, rect] of existing) {
      if (!inShape(key) || !tiles.has(key)) rect.remove();
    }
    const selectedBoxes = (except: string) =>
      [...tiles].filter(([key]) => key !== except && selected.has(key)).map(([, tile]) => tile.box);
    for (const [key, tile] of tiles) {
      if (!inShape(key)) continue;
      let rect = existing.get(key);
      if (!rect?.isConnected) {
        rect = document.createElementNS(SVG, 'rect');
        rect.dataset.key = key;
        shapes.append(rect);
      }
      // A little past half the gap, so two selected neighbours overlap and flow together.
      rounded(rect, tile.box, gap * 0.75, tile.radius);
      const joining = changed.added.includes(key);
      const leaving = changed.removed.includes(key);
      if (reduced || (!joining && !leaving)) continue;
      const end = gathered(fillOrigin(tile.box, selectedBoxes(key), gap));
      rect.style.transformBox = 'fill-box';
      rect.style.transformOrigin = end.origin;
      for (const running of rect.getAnimations()) running.cancel();
      const animation = rect.animate(
        joining ? [{ transform: end.transform }, { transform: 'none' }] : [{ transform: 'none' }, { transform: end.transform }],
        { duration: FILL_MS, easing: EASING, fill: leaving ? 'forwards' : 'none' }
      );
      if (leaving) {
        void animation.finished.then(
          () => {
            draining.current.delete(key);
            if (!selected.has(key)) rect.remove();
            draw({ added: [], removed: [] });
          },
          () => draining.current.delete(key)
        );
      }
    }
    // The gap of a tile left out follows that tile's rounded outline.
    cuts.replaceChildren(
      ...[...tiles]
        .filter(([key]) => !inShape(key))
        .map(([, tile]) => {
          const cut = document.createElementNS(SVG, 'rect');
          rounded(cut, tile.box, gap / 2, tile.radius);
          return cut;
        })
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

  const goo = `${id}-goo`;
  const cutOut = `${id}-cut`;
  return (
    <svg ref={svgRef} className="selection-layer" aria-hidden="true">
      <defs>
        <filter id={goo} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="4" />
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -11" />
        </filter>
        <mask id={cutOut} maskUnits="userSpaceOnUse" x="-100%" y="-100%" width="300%" height="300%">
          <rect x="-100%" y="-100%" width="300%" height="300%" fill="white" />
          <g data-part="cuts" fill="black" />
        </mask>
      </defs>
      <g mask={`url(#${cutOut})`}>
        <g filter={`url(#${goo})`} data-part="shapes" />
      </g>
    </svg>
  );
}
