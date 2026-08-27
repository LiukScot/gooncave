import { describe, expect, it } from 'vitest';

import { distributeIntoColumns } from './masonry';

/** Square tiles unless the id encodes a ratio, e.g. "tall:0.5". */
const ratioOf = (id: string) =>
  id.includes(':') ? Number(id.split(':')[1]) : 1;

describe('distributeIntoColumns', () => {
  it('fills the first row left-to-right when all tiles are equal', () => {
    const columns = distributeIntoColumns(['a', 'b', 'c', 'd'], 2, ratioOf);
    expect(columns).toEqual([
      ['a', 'c'],
      ['b', 'd']
    ]);
  });

  it('sends the next tile to the shortest column', () => {
    // "tall" is half as wide as high, so it occupies two column-widths of
    // height; the next two squares both belong on the right.
    const columns = distributeIntoColumns(
      ['tall:0.5', 'b', 'c', 'd'],
      2,
      ratioOf
    );
    expect(columns).toEqual([
      ['tall:0.5', 'd'],
      ['b', 'c']
    ]);
  });

  it('treats unknown dimensions as square', () => {
    const columns = distributeIntoColumns(
      ['a', 'b'],
      2,
      () => null as number | null
    );
    expect(columns).toEqual([['a'], ['b']]);
  });

  it('keeps earlier items in place when a page is appended', () => {
    const first = ['a', 'tall:0.5', 'c'];
    const before = distributeIntoColumns(first, 3, ratioOf);
    const after = distributeIntoColumns([...first, 'd', 'e'], 3, ratioOf);
    before.forEach((column, i) =>
      expect(after[i].slice(0, column.length)).toEqual(column)
    );
  });

  it('returns the requested number of columns even when items run out', () => {
    expect(distributeIntoColumns(['a'], 3, ratioOf)).toEqual([['a'], [], []]);
  });
});
