// @vitest-environment happy-dom

import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./VirtualGalleryMasonry', () => ({
  VirtualGalleryMasonry: () => <div data-testid="masonry" />
}));

import { GalleryView, type GalleryViewProps } from './GalleryView';

import type { FileItem } from '@/api';

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
    duplicateGroups: [],
    duplicateScanError: null,
    sourceSites: [],
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
    onUpvote: vi.fn(),
    onLoadMore: vi.fn(),
    onMarkLoadedRead: vi.fn(),
    ...overrides
  };
  act(() => root?.render(<GalleryView {...props} />));
  return container;
};

const unreadButton = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Unread only'
  );

const file: FileItem = {
  id: 'file-1',
  folderId: 'folder',
  path: '/library/1.jpg',
  locationType: 'LOCAL',
  sizeBytes: 1,
  mtime: '2026-01-01T00:00:00.000Z',
  sha256: 'hash',
  phash: null,
  mediaType: 'IMAGE',
  width: 100,
  height: 100,
  durationMs: null,
  thumbPath: null,
  thumbUrl: '/thumb.jpg',
  voteScore: 0,
  nextVoteAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

it('offers explicit read completion only on the final unread page', () => {
  const onMarkLoadedRead = vi.fn();
  const container = renderGallery({ galleryFiles: [file], onMarkLoadedRead });
  const markButton = [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Mark as read'
  );
  expect(markButton).toBeDefined();
  act(() => markButton?.click());
  expect(onMarkLoadedRead).toHaveBeenCalledOnce();
});

it('keeps Load more instead of completion while another page exists', () => {
  const container = renderGallery({ galleryFiles: [file], galleryHasMore: true });
  expect(container.textContent).toContain('Load more');
  expect(container.textContent).not.toContain('Mark as read');
});

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
