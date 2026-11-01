// @vitest-environment happy-dom

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
  expect(takeGalleryAnchor(stacks, items, items, 400, 100, null)).toEqual({
    after: ['c', 'd'],
    before: ['b', 'b-copy', 'a'],
    viewportTop: 120
  });
});

it('falls back to a tile taller than the screen, cut by its top edge', () => {
  expect(takeGalleryAnchor(stacks, [item(0, 100, 3000)], items, 400, 100, null)?.viewportTop).toBe(-300);
});

it('has no anchor for a reader still at the top of the list', () => {
  expect(takeGalleryAnchor(stacks, items, items, 100, 100, null)).toBeNull();
});

it('anchors to the open file, also from the top of the list', () => {
  expect(takeGalleryAnchor(stacks, items, items, 100, 100, 'b')).toEqual({
    after: ['b', 'b-copy', 'c', 'd'],
    before: ['a'],
    viewportTop: 210
  });
});

it('keeps an open file far from where the list was left on screen', () => {
  expect(takeGalleryAnchor(stacks, items, items, 800, 100, 'a')?.viewportTop).toBe(0);
  expect(takeGalleryAnchor(stacks, items, items, 100, 100, 'd')?.viewportTop).toBe(window.innerHeight / 2);
});

it('finds the first listed file the new list holds, also as a copy in a stack', () => {
  const left = [stack('z'), stack('d'), stack('c-other', 'c')];
  expect(findAnchorTile(left, ['c', 'd'])).toBe(2);
  expect(findAnchorTile(left, ['gone', 'd'])).toBe(1);
  expect(findAnchorTile(left, ['gone'])).toBe(-1);
});
