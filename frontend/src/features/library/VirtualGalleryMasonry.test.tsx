// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { VirtualGalleryMasonry } from './VirtualGalleryMasonry';

import type { BooruSite, DuplicateFile, FileItem } from '@/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const rect = (width: number, height: number, top = 0): DOMRect =>
  ({
    x: 0,
    y: top,
    width,
    height,
    top,
    right: width,
    bottom: top + height,
    left: 0,
    toJSON: () => ({})
  }) as DOMRect;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let notifyResize: (() => void) | null = null;

class ControlledResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    notifyResize = () => callback([], this as unknown as ResizeObserver);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const fileAt = (index: number): FileItem => ({
  id: `file-${index}`,
  folderId: 'folder',
  path: `/library/${index}.jpg`,
  locationType: 'LOCAL',
  sizeBytes: 1,
  mtime: '2026-01-01T00:00:00.000Z',
  sha256: String(index),
  phash: null,
  mediaType: 'IMAGE',
  width: index % 3 === 0 ? 400 : 800,
  height: index % 3 === 0 ? 800 : 600,
  durationMs: null,
  thumbPath: null,
  thumbUrl: `/thumbnails/${index}.jpg`,
  voteScore: 0,
  nextVoteAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
});

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  notifyResize = null;
});

it.each([200, 1_000, 5_000, 10_000])(
  'keeps mounted cards bounded with %i loaded files',
  async (count) => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('gallery-masonry')) return rect(1000, 0, 100);
        if (this.classList.contains('gallery-masonry-item')) {
          const width = Number.parseFloat(this.style.width) || 194;
          const ratio = Number.parseFloat(
            this.querySelector<HTMLElement>('.gallery-thumb')?.style.getPropertyValue(
              '--gallery-thumb-ratio'
            ) ?? ''
          );
          return rect(width, ratio ? width / ratio : 220);
        }
        return rect(1000, 800);
      }
    );
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <VirtualGalleryMasonry
          files={Array.from({ length: count }, (_, index) => fileAt(index))}
          voteSystemEnabled={false}
          onFileOpen={() => undefined}
          onUpvote={async () => undefined}
        />
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const cards = container.querySelectorAll('[data-test-id="file-card"]');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThan(100);
    container.remove();
  }
);

it('shows sources from an off-page copy on one fixed tile without a switch', async () => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains('gallery-masonry')) return rect(600, 0, 100);
      return rect(250, 250);
    }
  );
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  const onFileOpen = vi.fn();
  const offPageFile: DuplicateFile = {
    id: 'file-1',
    folderId: 'folder',
    path: '/library/1.jpg',
    mediaType: 'IMAGE',
    sizeBytes: 1,
    width: 800,
    height: 600,
    durationMs: null,
    thumbUrl: '/thumbnails/1.jpg',
    favoriteProviders: ['danbooru-site']
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <VirtualGalleryMasonry
        files={[fileAt(0)]}
        duplicateGroups={[{
          key: 'local-duplicates',
          files: [{ ...fileAt(0), favoriteProviders: ['e-site'] }, offPageFile]
        }]}
        sourceSites={[
          { id: 'danbooru-site', name: 'Danbooru', baseUrl: 'https://danbooru.donmai.us', presetKey: null },
          { id: 'e-site', name: 'e', baseUrl: 'https://rule34.xxx', presetKey: null }
        ] as BooruSite[]}
        voteSystemEnabled={false}
        onFileOpen={onFileOpen}
        onUpvote={async () => undefined}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(container.querySelectorAll('.gallery-masonry-item')).toHaveLength(1);
  expect(container.querySelector('.gallery-stack-switch')).toBeNull();
  expect(container.querySelector('.gallery-source-icons')?.getAttribute('aria-label'))
    .toBe('Sources: e, Danbooru');
  expect(container.querySelector<HTMLImageElement>('.gallery-thumb-img')?.src).toContain('/thumbnails/0.jpg');
  await act(async () => container.querySelector<HTMLButtonElement>('[data-test-id="file-card"]')?.click());
  expect(onFileOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-0' }));
  container.remove();
});

it('shows an upvote at zero and replaces it with a cooldown clock after voting', async () => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains('gallery-masonry')) return rect(600, 0, 100);
      return rect(250, 250);
    }
  );
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  const onFileOpen = vi.fn();
  const onUpvote = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <VirtualGalleryMasonry
        files={[fileAt(0)]}
        voteSystemEnabled
        onFileOpen={onFileOpen}
        onUpvote={onUpvote}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const upvote = container.querySelector<HTMLButtonElement>('[data-test-id="card-upvote"]');
  expect(upvote?.disabled).toBe(false);
  expect(upvote?.getAttribute('aria-label')).toBe('Upvote; score 0');
  expect(upvote?.querySelector('svg.lucide-chevron-up')).not.toBeNull();
  expect(container.querySelector('[data-test-id="file-card"] [data-test-id="card-upvote"]')).toBeNull();
  await act(async () => upvote?.click());
  expect(onUpvote).toHaveBeenCalledOnce();
  expect(onUpvote).toHaveBeenCalledWith('file-0');
  expect(onFileOpen).not.toHaveBeenCalled();

  await act(async () => {
    root?.render(
      <VirtualGalleryMasonry
        files={[{ ...fileAt(0), voteScore: 1, nextVoteAt: new Date(Date.now() + 60_000).toISOString() }]}
        voteSystemEnabled
        onFileOpen={onFileOpen}
        onUpvote={onUpvote}
      />
    );
  });
  const cooldown = container.querySelector<HTMLButtonElement>('[data-test-id="card-upvote"]');
  expect(cooldown?.disabled).toBe(true);
  expect(cooldown?.querySelector('svg.lucide-clock')).not.toBeNull();
  expect(container.querySelector('button[aria-label^="Vote down"]')).toBeNull();
  container.remove();
});

it('recomputes masonry positions when width changes within one lane count', async () => {
  let masonryWidth = 1_000;
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains('gallery-masonry')) {
        return rect(masonryWidth, 0, 100);
      }
      return rect(masonryWidth, 800);
    }
  );
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: 800
  });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <VirtualGalleryMasonry
        files={Array.from({ length: 40 }, (_, index) => fileAt(index))}
        voteSystemEnabled={false}
        onFileOpen={() => undefined}
        onUpvote={async () => undefined}
      />
    );
  });
  const masonry = container.querySelector<HTMLElement>('.gallery-masonry');
  expect(masonry).not.toBeNull();
  const initialHeight = masonry!.style.height;

  masonryWidth = 1_040;
  await act(async () => notifyResize?.());

  expect(masonry!.style.height).not.toBe(initialHeight);
  container.remove();
});
