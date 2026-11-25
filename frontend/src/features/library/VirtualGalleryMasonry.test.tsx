// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import * as sourceIcons from './gallerySourceIcons';
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
  stars: 0,
  nextStarAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
});

let root: ReturnType<typeof createRoot> | null = null;

it('does not recompute unchanged card sources when the scroll range updates', async () => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('gallery-masonry')
        ? rect(1000, 0, 100)
        : rect(250, 250);
    }
  );
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  const sources = vi.spyOn(sourceIcons, 'gallerySourceIcons');
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const files = Array.from({ length: 200 }, (_, index) => fileAt(index));
  const duplicateGroups: [] = [];
  const sourceSites: BooruSite[] = [];
  const onFileOpen = vi.fn();
  const onGiveStar = vi.fn().mockResolvedValue(undefined);
  const render = () => root?.render(
    <VirtualGalleryMasonry
      files={files}
      duplicateGroups={duplicateGroups}
      sourceSites={sourceSites}
      starsEnabled={false}
      onFileOpen={onFileOpen}
      onGiveStar={onGiveStar}
    />
  );
  await act(async () => {
    render();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const initialComputations = sources.mock.calls.length;
  expect(initialComputations).toBeGreaterThan(0);
  await act(async () => {
    window.dispatchEvent(new Event('scroll'));
    render();
  });
  expect(sources.mock.calls.length).toBe(initialComputations);
  container.remove();
});

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
          starsEnabled={false}
          onFileOpen={() => undefined}
          onGiveStar={async () => undefined}
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
        starsEnabled={false}
        onFileOpen={onFileOpen}
        onGiveStar={async () => undefined}
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

it('uses a bounded animated thumbnail and a placeholder when no thumbnail exists', async () => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('gallery-masonry')
        ? rect(600, 0, 100)
        : rect(250, 250);
    }
  );
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <VirtualGalleryMasonry
        files={[
          { ...fileAt(0), path: '/library/animated.gif', thumbUrl: '/thumbnails/animated.webp' },
          { ...fileAt(1), thumbUrl: null }
        ]}
        starsEnabled={false}
        onFileOpen={() => undefined}
        onGiveStar={async () => undefined}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const urls = Array.from(container.querySelectorAll<HTMLImageElement>('.gallery-thumb-img'))
    .map((image) => image.src);
  expect(urls).toEqual([expect.stringContaining('/thumbnails/animated.webp')]);
  expect(container.querySelectorAll('[data-test-id="file-card"]')).toHaveLength(2);
  expect(container.textContent).toContain('image');
  container.remove();
});

it('caps gallery columns and grows tiles on a wide screen', async () => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('gallery-masonry')
        ? rect(1000, 0, 100)
        : rect(500, 500);
    }
  );
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <VirtualGalleryMasonry
        files={[fileAt(0), fileAt(1)]}
        maxGridColumns={2}
        starsEnabled={false}
        onFileOpen={() => undefined}
        onGiveStar={async () => undefined}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.querySelector<HTMLElement>('.gallery-masonry-item')?.style.width)
    .toBe('500px');
  container.remove();
});

it('draws and packs a file of unknown size as a square, so no hole opens under its thumbnail', async () => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('gallery-masonry') ? rect(1000, 0, 100) : rect(500, 500);
    }
  );
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const unprobed = (index: number) => ({ ...fileAt(index), mediaType: 'VIDEO' as const, width: null, height: null });
  await act(async () => {
    root?.render(
      <VirtualGalleryMasonry
        files={[unprobed(0), unprobed(1), unprobed(2)]}
        maxGridColumns={2}
        starsEnabled={false}
        onFileOpen={() => undefined}
        onGiveStar={async () => undefined}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const items = [...container.querySelectorAll<HTMLElement>('.gallery-masonry-item')];
  const offset = (item: HTMLElement) => item.style.transform.match(/-?[\d.]+px/g)!.map(parseFloat);
  const width = parseFloat(items[0].style.width);
  const gap = offset(items[1])[0] - width;
  // The third tile sits one square and a gap under the first.
  expect(offset(items[2])[1] - offset(items[0])[1]).toBe(width + gap);
  expect(items[0].querySelector<HTMLElement>('.gallery-thumb')?.style.getPropertyValue('--gallery-thumb-ratio')).toBe('1');
  container.remove();
});

it('shows a star at zero and replaces it with a cooldown clock after giving one', async () => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains('gallery-masonry')) return rect(600, 0, 100);
      return rect(250, 250);
    }
  );
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  const onFileOpen = vi.fn();
  const onGiveStar = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <VirtualGalleryMasonry
        files={[fileAt(0)]}
        starsEnabled
        onFileOpen={onFileOpen}
        onGiveStar={onGiveStar}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const star = container.querySelector<HTMLButtonElement>('[data-test-id="card-star"]');
  expect(star?.disabled).toBe(false);
  expect(star?.getAttribute('aria-label')).toBe('Give a star; 0 stars');
  expect(star?.querySelector('svg.lucide-star')).not.toBeNull();
  expect(container.querySelector('[data-test-id="file-card"] [data-test-id="card-star"]')).toBeNull();
  await act(async () => star?.click());
  expect(onGiveStar).toHaveBeenCalledOnce();
  expect(onGiveStar).toHaveBeenCalledWith('file-0');
  expect(onFileOpen).not.toHaveBeenCalled();

  await act(async () => {
    root?.render(
      <VirtualGalleryMasonry
        files={[{ ...fileAt(0), stars: 1, nextStarAt: new Date(Date.now() + 60_000).toISOString() }]}
        starsEnabled
        onFileOpen={onFileOpen}
        onGiveStar={onGiveStar}
      />
    );
  });
  const cooldown = container.querySelector<HTMLButtonElement>('[data-test-id="card-star"]');
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
        starsEnabled={false}
        onFileOpen={() => undefined}
        onGiveStar={async () => undefined}
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

it('plays a video inside its tile and pauses it once the tile leaves the screen', async () => {
  let leaveScreen: (() => void) | null = null;
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        leaveScreen = () =>
          callback(
            [{ isIntersecting: false } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver
          );
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('gallery-masonry')
        ? rect(600, 0, 100)
        : rect(250, 250);
    }
  );
  const pause = vi
    .spyOn(HTMLMediaElement.prototype, 'pause')
    .mockImplementation(() => undefined);
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  const opened: string[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <VirtualGalleryMasonry
        files={[
          { ...fileAt(0), path: '/library/clip.mp4', mediaType: 'VIDEO' },
          fileAt(1)
        ]}
        starsEnabled={false}
        onFileOpen={(file) => opened.push(file.id)}
        onGiveStar={async () => undefined}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const playButtons = container.querySelectorAll<HTMLButtonElement>(
    '[data-test-id="gallery-video-play"]'
  );
  expect(playButtons).toHaveLength(1);
  expect(container.querySelector('video')).toBeNull();

  await act(async () => playButtons[0].click());

  const video = container.querySelector<HTMLVideoElement>(
    '[data-test-id="gallery-inline-video"]'
  );
  expect(video?.src).toContain('/files/file-0/content');
  expect(opened).toEqual([]);
  expect(container.querySelector('[data-test-id="gallery-video-play"]')).toBeNull();

  act(() => leaveScreen?.());
  expect(pause).toHaveBeenCalledTimes(1);
  container.remove();
});
