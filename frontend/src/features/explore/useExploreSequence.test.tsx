// @vitest-environment happy-dom

import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useExploreSequence, type ExploreSequence } from './useExploreSequence';

import type { ExplorePost } from '@/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const post = (remoteId: string): ExplorePost => ({
  remoteId,
  previewUrl: null,
  sampleUrl: null,
  fileUrl: null,
  width: null,
  height: null,
  score: null,
  rating: null,
  md5: null,
  createdAt: null,
  tags: [],
  favCount: null,
  uploader: null,
  fileExt: null,
  fileSize: null,
  favorited: false,
  voted: null,
  siteId: 'site',
  siteName: 'Site',
  engine: 'danbooru',
  sourceUrl: 'https://example.test/posts/' + remoteId,
  parentId: null,
  hasChildren: false,
  poolIds: []
});

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('useExploreSequence', () => {
  it('loads once and opens the first new result at the loaded edge', async () => {
    const first = post('1');
    const next = post('2');
    const loadMore = vi.fn(async () => [next]);
    let sequence: ExploreSequence | null = null;
    let selected: ExplorePost | null = null;

    function Harness() {
      const [selectedPost, setSelectedPost] = useState<ExplorePost | null>(
        first
      );
      sequence = useExploreSequence({
        posts: [first],
        poolContext: null,
        setPoolContext: vi.fn(),
        selectedPost,
        setSelectedPost,
        hasMore: true,
        loadMore
      });
      selected = selectedPost;
      return null;
    }

    const container = document.createElement('div');
    root = createRoot(container);
    await act(async () => {
      root?.render(<Harness />);
    });
    await act(async () => {
      sequence?.goRelative(1);
      await Promise.resolve();
    });

    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(selected).toBe(next);
  });

  it('does not fetch beyond the last real result', async () => {
    const first = post('1');
    const loadMore = vi.fn(async () => [post('2')]);
    let sequence: ExploreSequence | null = null;

    function Harness() {
      const [selectedPost, setSelectedPost] = useState<ExplorePost | null>(
        first
      );
      sequence = useExploreSequence({
        posts: [first],
        poolContext: null,
        setPoolContext: vi.fn(),
        selectedPost,
        setSelectedPost,
        hasMore: false,
        loadMore
      });
      return null;
    }

    const container = document.createElement('div');
    root = createRoot(container);
    await act(async () => {
      root?.render(<Harness />);
    });
    await act(async () => sequence?.goRelative(1));

    expect(loadMore).not.toHaveBeenCalled();
  });
});
