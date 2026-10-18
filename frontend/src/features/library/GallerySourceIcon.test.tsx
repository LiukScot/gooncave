// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';

import { GallerySourceIconList } from './GallerySourceIcon';
import type { GallerySourceIcon } from './gallerySourceIcons';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const icons: GallerySourceIcon[] = ['a', 'b', 'c', 'd', 'e'].map((key) => ({
  key, label: `Site ${key}`, iconUrl: null
}));

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

const render = (list: GallerySourceIcon[], activeKey?: string) => {
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root?.render(<GallerySourceIconList icons={list} activeKey={activeKey} />));
  return [...container.querySelectorAll('.gallery-source-icon')].map((node) => node.textContent || node.getAttribute('title'));
};

it('shows every icon up to three', () => {
  expect(render(icons.slice(0, 3))).toEqual(['Site a', 'Site b', 'Site c']);
});

it('keeps three icons and counts the others in a badge', () => {
  expect(render(icons)).toEqual(['Site a', 'Site b', 'Site c', '+2']);
});

it('keeps the icon of the copy on screen visible', () => {
  expect(render(icons, 'e')).toEqual(['Site a', 'Site b', 'Site e', '+2']);
});
