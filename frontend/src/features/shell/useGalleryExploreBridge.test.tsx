// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGalleryExploreBridge } from './useGalleryExploreBridge';

import type { FileItem } from '@/api';
import type { GalleryControllerOutput } from '@/features/library/useGalleryController';
import type { GalleryExcursionNav } from '@/stores/exploreUiStore';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => true
}));

const file = (id: string): FileItem => ({
  id,
  folderId: 'folder',
  path: '/' + id,
  locationType: 'LOCAL',
  sizeBytes: 1,
  mtime: '2026-01-01T00:00:00.000Z',
  sha256: id,
  phash: null,
  mediaType: 'IMAGE',
  width: null,
  height: null,
  durationMs: null,
  thumbPath: null,
  thumbUrl: null,
  voteScore: 0,
  nextVoteAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
});

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('useGalleryExploreBridge', () => {
  it('returns to the selected gallery sequence and opens its next file', async () => {
    const first = file('first');
    const next = file('next');
    const controller: GalleryControllerOutput = {
      galleryFiles: [first, next],
      galleryHasMore: false,
      selectedFileIndex: (id) => [first, next].findIndex((item) => item.id === id),
      goRelative: vi.fn(),
      viewProps: {} as GalleryControllerOutput['viewProps'],
      resetGallery: vi.fn(),
      reloadGallery: vi.fn(),
      updateVote: vi.fn(),
      removeFileFromGallery: vi.fn(),
      restoreFileToGallery: vi.fn()
    };
    const navigate = vi.fn(async () => undefined);
    const openFile = vi.fn();
    let bridge: GalleryExcursionNav | null = null;

    function Harness() {
      useGalleryExploreBridge({
        galleryControllerRef: { current: controller },
        selectedFileRef: { current: first },
        openFileRef: { current: openFile },
        navigate,
        setGalleryBridge: (value) => {
          bridge = value;
        }
      });
      return null;
    }

    const container = document.createElement('div');
    root = createRoot(container);
    await act(async () => {
      root?.render(<Harness />);
    });
    await act(async () => bridge?.goRelative(1));

    expect(bridge).toMatchObject({
      backLabel: 'Back to gallery',
      hasPrev: false,
      hasNext: true
    });
    expect(navigate).toHaveBeenCalledWith({
      to: '/app/gallery',
      replace: true,
      search: { fileId: 'next', fs: undefined }
    });
    expect(openFile).toHaveBeenCalledWith(next);
  });
});
