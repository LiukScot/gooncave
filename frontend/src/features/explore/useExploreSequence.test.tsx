// @vitest-environment happy-dom

import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useExploreSequence, type ExploreSequence } from './useExploreSequence';

import { api, type ExplorePost } from '@/api';

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
  vi.restoreAllMocks();
});

describe('useExploreSequence', () => {
  it('ignores a late Next result after the reader moved back', async () => {
    const first = post('1');
    const second = post('2');
    const third = post('3');
    let finishLoad: ((posts: ExplorePost[]) => void) | undefined;
    const loadMore = vi.fn(() => new Promise<ExplorePost[]>((resolve) => {
      finishLoad = resolve;
    }));
    let sequence: ExploreSequence | null = null;
    let selected: ExplorePost | null = null;

    function Harness() {
      const [selectedPost, setSelectedPost] = useState<ExplorePost | null>(second);
      sequence = useExploreSequence({
        posts: [first, second],
        poolContext: null,
        setPoolContext: vi.fn(),
        selectedPost,
        setSelectedPost,
        hasMore: true,
        loading: false,
        loadMore
      });
      selected = selectedPost;
      return null;
    }

    root = createRoot(document.createElement('div'));
    await act(async () => root?.render(<Harness />));
    act(() => sequence?.goRelative(1));
    const resolveNext = finishLoad;
    act(() => sequence?.goRelative(-1));
    await act(async () => resolveNext?.([third]));

    expect(selected).toBe(first);
  });

  it('does not keep loading pages while the reader stays on one post', async () => {
    const first = post('1');
    const next = post('2');
    const loadMore = vi.fn(async () => [next]);

    function Harness() {
      const [posts, setPosts] = useState([first]);
      useExploreSequence({
        posts,
        poolContext: null,
        setPoolContext: vi.fn(),
        selectedPost: first,
        setSelectedPost: vi.fn(),
        hasMore: true,
        loading: false,
        loadMore: async () => {
          const loaded = await loadMore();
          setPosts((current) => [...current, ...loaded]);
          return loaded;
        }
      });
      return null;
    }

    root = createRoot(document.createElement('div'));
    await act(async () => root?.render(<Harness />));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('preloads an unloaded pool page and shares it with Next', async () => {
    const first = post('1');
    const next = post('2');
    let finishLoad: ((result: Awaited<ReturnType<typeof api.explorePost>>) => void) | undefined;
    const fetchPost = vi.spyOn(api, 'explorePost').mockImplementation(
      () => new Promise((resolve) => { finishLoad = resolve; })
    );
    let sequence: ExploreSequence | null = null;
    let selected: ExplorePost | null = null;

    function Harness() {
      const [selectedPost, setSelectedPost] = useState<ExplorePost | null>(first);
      const [poolContext, setPoolContext] = useState<{
        siteId: string;
        poolId: string;
        postIds: string[];
        posts: ExplorePost[];
      } | null>({
        siteId: 'site',
        poolId: 'pool',
        postIds: ['1', '2'],
        posts: [first]
      });
      sequence = useExploreSequence({
        posts: [],
        poolContext,
        setPoolContext,
        selectedPost,
        setSelectedPost,
        hasMore: false,
        loading: false,
        loadMore: vi.fn(async () => [])
      });
      selected = selectedPost;
      return null;
    }

    root = createRoot(document.createElement('div'));
    await act(async () => root?.render(<Harness />));
    expect(fetchPost).toHaveBeenCalledTimes(1);

    act(() => sequence?.goRelative(1));
    expect(fetchPost).toHaveBeenCalledTimes(1);
    await act(async () => finishLoad?.({ post: { ...next, localFileId: null } }));
    expect(selected).toEqual({ ...next, localFileId: null });
  });

  it('retries a pool page when its early request failed', async () => {
    const first = post('1');
    const next = { ...post('2'), localFileId: null };
    const fetchPost = vi.spyOn(api, 'explorePost')
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockResolvedValueOnce({ post: next });
    let sequence: ExploreSequence | null = null;
    let selected: ExplorePost | null = null;

    function Harness() {
      const [selectedPost, setSelectedPost] = useState<ExplorePost | null>(first);
      const [poolContext, setPoolContext] = useState<{
        siteId: string;
        poolId: string;
        postIds: string[];
        posts: ExplorePost[];
      } | null>({
        siteId: 'site',
        poolId: 'pool',
        postIds: ['1', '2'],
        posts: [first]
      });
      sequence = useExploreSequence({
        posts: [],
        poolContext,
        setPoolContext,
        selectedPost,
        setSelectedPost,
        hasMore: false,
        loading: false,
        loadMore: vi.fn(async () => [])
      });
      selected = selectedPost;
      return null;
    }

    root = createRoot(document.createElement('div'));
    await act(async () => root?.render(<Harness />));
    expect(fetchPost).toHaveBeenCalledTimes(1);

    await act(async () => sequence?.goRelative(1));
    expect(fetchPost).toHaveBeenCalledTimes(2);
    expect(selected).toEqual(next);
  });

  it('starts loading at the edge and reuses that request when Next is pressed', async () => {
    const first = post('1');
    const next = post('2');
    let finishLoad: ((posts: ExplorePost[]) => void) | undefined;
    const loadMore = vi.fn(() => new Promise<ExplorePost[]>((resolve) => {
      finishLoad = resolve;
    }));
    let sequence: ExploreSequence | null = null;
    let selected: ExplorePost | null = null;

    function Harness() {
      const [selectedPost, setSelectedPost] = useState<ExplorePost | null>(first);
      sequence = useExploreSequence({
        posts: [first],
        poolContext: null,
        setPoolContext: vi.fn(),
        selectedPost,
        setSelectedPost,
        hasMore: true,
        loading: false,
        loadMore
      });
      selected = selectedPost;
      return null;
    }

    root = createRoot(document.createElement('div'));
    await act(async () => root?.render(<Harness />));
    expect(loadMore).toHaveBeenCalledTimes(1);

    act(() => sequence?.goRelative(1));
    expect(loadMore).toHaveBeenCalledTimes(1);
    await act(async () => finishLoad?.([next]));
    expect(selected).toBe(next);
  });

  it('retries on Next when the early load found no posts', async () => {
    const first = post('1');
    const next = post('2');
    const loadMore = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([next]);
    let sequence: ExploreSequence | null = null;
    let selected: ExplorePost | null = null;

    function Harness() {
      const [selectedPost, setSelectedPost] = useState<ExplorePost | null>(first);
      sequence = useExploreSequence({
        posts: [first],
        poolContext: null,
        setPoolContext: vi.fn(),
        selectedPost,
        setSelectedPost,
        hasMore: true,
        loading: false,
        loadMore
      });
      selected = selectedPost;
      return null;
    }

    root = createRoot(document.createElement('div'));
    await act(async () => root?.render(<Harness />));
    expect(loadMore).toHaveBeenCalledTimes(1);

    await act(async () => sequence?.goRelative(1));
    expect(loadMore).toHaveBeenCalledTimes(2);
    expect(selected).toBe(next);
  });

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
        loading: false,
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
        loading: false,
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
