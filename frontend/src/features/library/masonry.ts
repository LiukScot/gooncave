/**
 * Narrowest a tile is allowed to be laid out, as width/height.
 *
 * A comic strip at 1:12 would otherwise claim a column twelve times its own
 * width: every other column ends far above it and the row below has nothing
 * to sit against, so the grid reads as a hole. Anything taller than this is
 * cropped to it (`object-fit: cover`) and opens whole in the detail view.
 */
export const TALLEST_TILE_RATIO = 0.5;

/**
 * The ratio a tile is drawn and packed at: the file's own, floored.
 *
 * Both numbers have to come from here — a tile laid out at one ratio and
 * packed at another leaves the columns misaligned by the difference.
 *
 * @param ratio the file's width/height, or null when it was never probed
 * @returns the clamped ratio, or null to fall back to a square box
 */
export const tileRatio = (ratio: number | null): number | null =>
  ratio && ratio > 0 ? Math.max(ratio, TALLEST_TILE_RATIO) : null;

/** Height a tile occupies once scaled to a column's width, in column-width
 *  units. Files whose dimensions were never probed are assumed square. */
const relativeHeight = (ratio: number | null) => {
  const clamped = tileRatio(ratio);
  return clamped ? 1 / clamped : 1;
};

/**
 * Greedily packs `items` into `columnCount` columns, always appending to the
 * currently shortest column so the columns end at roughly the same height.
 *
 * Ties go to the leftmost column, which keeps the first row reading
 * left-to-right. The walk is sequential and stateless across calls, so
 * appending a page of files leaves every earlier item in the column it
 * already had — infinite scroll never reshuffles what is on screen.
 *
 * `ratioOf` returns width/height, or null when the file has no known size.
 */
export function distributeIntoColumns<T>(
  items: T[],
  columnCount: number,
  ratioOf: (item: T) => number | null
): T[][] {
  const columns: T[][] = Array.from({ length: columnCount }, () => []);
  const heights = new Array<number>(columnCount).fill(0);

  for (const item of items) {
    let shortest = 0;
    for (let i = 1; i < columnCount; i += 1) {
      if (heights[i] < heights[shortest]) shortest = i;
    }
    columns[shortest].push(item);
    heights[shortest] += relativeHeight(ratioOf(item));
  }

  return columns;
}
