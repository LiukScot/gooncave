// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { VirtualGalleryMasonry } from './VirtualGalleryMasonry';

import type { FileItem } from '@/api';

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
