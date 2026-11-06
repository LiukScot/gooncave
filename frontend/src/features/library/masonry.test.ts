import { describe, expect, it } from 'vitest';

import {
  distributeIntoColumns,
  TALLEST_TILE_RATIO,
  tileRatio
} from './masonry';

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

describe('tileRatio', () => {
  it('leaves an ordinary tile alone', () => {
    expect(tileRatio(1.5)).toBe(1.5);
    expect(tileRatio(0.75)).toBe(0.75);
  });

  it('floors a strip so it cannot own the column', () => {
    expect(tileRatio(0.08)).toBe(TALLEST_TILE_RATIO);
  });

  it('has no opinion on a file that was never probed', () => {
    expect(tileRatio(null)).toBe(null);
    expect(tileRatio(0)).toBe(null);
  });
});

describe('distributeIntoColumns with a strip', () => {
  it('packs a strip at the clamped height, not its real one', () => {
    // 1:20 packs as 1:2, so two squares fit beside it rather than twenty.
    const columns = distributeIntoColumns(
      ['strip:0.05', 'b', 'c', 'd'],
      2,
      ratioOf
    );
    expect(columns).toEqual([
      ['strip:0.05', 'd'],
      ['b', 'c']
    ]);
  });
});
