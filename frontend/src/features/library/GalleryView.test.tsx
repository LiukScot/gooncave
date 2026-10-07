// @vitest-environment happy-dom

import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const masonryProps = vi.hoisted(() => vi.fn());
vi.mock('./VirtualGalleryMasonry', () => ({
  VirtualGalleryMasonry: (props: object) => {
    masonryProps(props);
    return <div data-testid="masonry" />;
  }
}));

import { GalleryView, type GalleryViewProps } from './GalleryView';

import type { FileItem } from '@/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  masonryProps.mockReset();
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
    maxGridColumns: 0,
    galleryFilters: { photos: true, videos: true },
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
    onFileOpen: vi.fn(),
    onUpvote: vi.fn(),
    onLoadMore: vi.fn(),
    ...overrides
  };
  act(() => root?.render(<GalleryView {...props} />));
  return container;
};

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

it('renders files while duplicate groups are still being prepared', () => {
  const container = renderGallery({
    galleryFiles: [file],
    galleryCountText: '1',
    duplicateGroups: null
  });

  expect(container.querySelector('[data-testid="masonry"]')).not.toBeNull();
  expect(container.textContent).not.toContain('Finding duplicate groups');
  expect(masonryProps).toHaveBeenCalledWith(
    expect.objectContaining({ files: [file], duplicateGroups: [] })
  );
});

it('shows random order without any read filter', () => {
  const container = renderGallery({ galleryFiles: [file], galleryHasMore: true });
  expect(container.textContent).not.toContain('Unread only');
  expect(container.textContent).not.toContain('Mark as read');
  expect(container.textContent).toContain('Load more');
});
