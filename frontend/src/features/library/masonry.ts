/** Height a tile occupies once scaled to a column's width, in column-width
 *  units. Files whose dimensions were never probed are assumed square. */
const relativeHeight = (ratio: number | null) =>
  ratio && ratio > 0 ? 1 / ratio : 1;

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
