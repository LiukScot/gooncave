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
import { DEFAULT_APPEARANCE, useAppearanceStore } from '@/stores/appearanceStore';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  useAppearanceStore.setState({ quickActions: DEFAULT_APPEARANCE.quickActions });
  masonryProps.mockReset();
});

const renderGallery = (overrides: Partial<GalleryViewProps>) => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const props: GalleryViewProps = {
    galleryFiles: [],
    duplicateGroups: [],
    duplicateScanError: null,
    sourceSites: [],
    galleryHasMore: false,
    galleryPageState: { loading: false, error: null },
    gallerySort: 'random',
    voteSystemEnabled: false,
    maxGridColumns: 0,
    galleryFilters: { photos: true, videos: true, downloaded: false },
    galleryTagInput: '',
    galleryLoadMoreRef: createRef(),
    onTagInputChange: vi.fn(),
    onTagSearchNow: vi.fn(),
    onFilterChange: vi.fn(),
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
    duplicateGroups: null
  });

  expect(container.querySelector('[data-testid="masonry"]')).not.toBeNull();
  expect(container.textContent).not.toContain('Finding duplicate groups');
  expect(masonryProps).toHaveBeenCalledWith(
    expect.objectContaining({ files: [file], duplicateGroups: [] })
  );
});

// The panel renders outside the view, at the end of the page.
const openPanel = (container: HTMLElement) => {
  act(() => container.ownerDocument.querySelector<HTMLButtonElement>('.search-lens')!.click());
  return document.querySelector<HTMLElement>('.search-panel')!;
};

it('says Offline at once when the connection drops during a sync', () => {
  vi.stubGlobal('navigator', { ...navigator, onLine: false });
  const panel = openPanel(renderGallery({
    favoritesSync: { running: true, error: null, onSync: vi.fn() }
  }));
  vi.unstubAllGlobals();
  const sync = panel.querySelector('.panel-pills button');
  expect(sync?.textContent).toBe('Offline');
  expect(sync?.querySelector('.animate-spin')).toBeNull();
});

it('says why nothing shows with photos and videos off, and turns them back on', () => {
  const onFilterChange = vi.fn();
  const container = renderGallery({ galleryFilters: { photos: false, videos: false, downloaded: false }, onFilterChange });
  expect(container.querySelector('.gallery-empty')?.textContent).toContain('Photos and Videos are both off');
  act(() => container.querySelector<HTMLButtonElement>('.gallery-empty button')!.click());
  expect(onFilterChange).toHaveBeenCalledWith({ photos: true, videos: true });
});

it('shows random order without any read filter', () => {
  const container = renderGallery({ galleryFiles: [file], galleryHasMore: true });
  expect(container.textContent).not.toContain('Unread only');
  expect(container.textContent).not.toContain('Mark as read');
  expect(container.textContent).toContain('Load more');
});

it('guides an empty library to account sync without manual upload controls', () => {
  const container = renderGallery({});
  expect(container.querySelector('.gallery-empty')?.textContent).toBe('No files yet. Add pictures and videos to your library folder, or connect your accounts to sync favorites from all your sites');
  expect(container.textContent).not.toContain('Upload files');
  expect(container.textContent).not.toContain('Library:');
});

it('moves the action not chosen as the quick button into the panel', () => {
  useAppearanceStore.setState({
    quickActions: { ...DEFAULT_APPEARANCE.quickActions, gallery: 'sync' }
  });
  renderGallery({
    onAddFiles: vi.fn(),
    favoritesSync: { running: false, error: null, onSync: vi.fn() }
  });
  expect(document.querySelector('.search-lens-action')?.getAttribute('aria-label')).toBe('Sync favorites');
  act(() => document.querySelector<HTMLButtonElement>('.search-lens')?.click());
  expect([...document.querySelectorAll('.search-panel .panel-pills .panel-pill')].map((pill) => pill.textContent))
    .toEqual(['Add files']);
});

it('hands the files picked with "Add files" to the library, and lets the same ones be picked again', () => {
  renderGallery({});
  expect(document.querySelector('input[type="file"]')).toBeNull();
  act(() => root?.unmount());
  const onAddFiles = vi.fn();
  renderGallery({ onAddFiles });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const photo = new File(['x'], 'cat.jpg', { type: 'image/jpeg' });
  Object.defineProperty(input, 'files', { value: [photo], configurable: true });
  act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(onAddFiles).toHaveBeenCalledWith([photo]);
  expect(document.querySelector('.search-lens-action[aria-label="Add files"]')).not.toBeNull();
});
