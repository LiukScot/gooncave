import type { VirtualItem } from '@tanstack/react-virtual';
import { expect, it } from 'vitest';

import type { GalleryStack } from './galleryDuplicateStacks';
import { findAnchorTile, takeGalleryAnchor } from './useGalleryAnchor';

const stack = (...ids: string[]) => {
  const members = ids.map((id) => ({ id }));
  return { anchor: members[0], members } as unknown as GalleryStack;
};
const item = (index: number, start: number, end: number) => ({ index, start, end }) as VirtualItem;

const stacks = [stack('a'), stack('b', 'b-copy'), stack('c'), stack('d')];
const items = [item(0, 100, 300), item(1, 310, 510), item(2, 520, 720), item(3, 730, 930)];

it('anchors to the first tile whole on screen, keeping its height in the window', () => {
  expect(takeGalleryAnchor(stacks, items, 400, 100)).toEqual({
    after: ['c', 'd'],
    before: ['b', 'b-copy', 'a'],
    viewportTop: 120
  });
});

it('falls back to a tile taller than the screen, cut by its top edge', () => {
  expect(takeGalleryAnchor(stacks, [item(0, 100, 3000)], 400, 100)?.viewportTop).toBe(-300);
});

it('has no anchor for a reader still at the top of the list', () => {
  expect(takeGalleryAnchor(stacks, items, 100, 100)).toBeNull();
});

it('finds the first listed file the new list holds, also as a copy in a stack', () => {
  const left = [stack('z'), stack('d'), stack('c-other', 'c')];
  expect(findAnchorTile(left, ['c', 'd'])).toBe(2);
  expect(findAnchorTile(left, ['gone', 'd'])).toBe(1);
  expect(findAnchorTile(left, ['gone'])).toBe(-1);
});
