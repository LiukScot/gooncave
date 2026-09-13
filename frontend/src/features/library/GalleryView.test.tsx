// @vitest-environment happy-dom

import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { GalleryView, type GalleryViewProps } from './GalleryView';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

const renderGallery = (overrides: Partial<GalleryViewProps>) => {
  const container = document.createElement('div');
  root = createRoot(container);
  const props: GalleryViewProps = {
    galleryFolderId: '',
    galleryFiles: [],
    galleryHasMore: false,
    galleryPageState: { loading: false, error: null },
    gallerySort: 'random',
    voteSystemEnabled: false,
    galleryFilters: { photos: true, videos: true },
    galleryUnreadOnlyEnabled: true,
    galleryUnreadOnly: true,
    isGalleryFilterOpen: false,
    galleryTagInput: '',
    galleryFilterLabel: 'All',
    galleryCountText: '0',
    selectedGalleryFolder: null,
    orderedFolders: [],
    folderDetailsById: new Map(),
    galleryFilterRef: createRef(),
    galleryLoadMoreRef: createRef(),
    onFolderChange: vi.fn(),
    onTagInputChange: vi.fn(),
    onTagQueryClear: vi.fn(),
    onFilterChange: vi.fn(),
    onFilterClose: vi.fn(),
    onFilterOpenToggle: vi.fn(),
    onSortChange: vi.fn(),
    onUnreadOnlyToggle: vi.fn(),
    onReadReset: vi.fn(),
    onFileOpen: vi.fn(),
    onLoadMore: vi.fn(),
    ...overrides
  };
  act(() => root?.render(<GalleryView {...props} />));
  return container;
};

const unreadButton = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Unread only'
  );

it('offers Unread only in random order when the extra setting allows it', () => {
  const container = renderGallery({});
  expect(unreadButton(container)).toBeDefined();
  expect(container.textContent).toContain('You have read everything here.');
});

it('drops the read system when the extra setting is off', () => {
  const container = renderGallery({ galleryUnreadOnlyEnabled: false });
  expect(unreadButton(container)).toBeUndefined();
  // A stored "unread only" from before must not keep filtering the gallery.
  expect(container.textContent).not.toContain('You have read everything here.');
});
