// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PoolView } from './PoolView';

import { api, type PoolPage } from '@/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ site: 'site', pool: 'pool' }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>
}));
vi.mock('@/features/explore/useOpenBooruPost', () => ({
  useOpenPoolPage: () => vi.fn()
}));
vi.mock('./PoolTile', () => ({
  PoolTile: ({ post, onOpen }: { post: { position: number }; onOpen: () => void }) => (
    <button onClick={onOpen}>Page {post.position}</button>
  )
}));
vi.mock('./PoolHeaderActions', () => ({
  PoolHeaderActions: () => null
}));
vi.mock('@/features/file-detail/restoreScrollTo', () => ({
  restoreScrollTo: vi.fn(() => vi.fn())
}));

const page = (number: number): PoolPage => ({
  siteId: 'site',
  poolId: 'pool',
  siteName: 'Site',
  name: 'Pool',
  postCount: 3,
  page: number,
  pageSize: 1,
  postIds: ['one', 'two', 'three'],
  posts: [{ position: number, remoteId: String(number) } as PoolPage['posts'][number]]
});

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
});

describe('PoolView return', () => {
  it('keeps loaded pages and the reading position across a detail excursion', async () => {
    const fetchPage = vi.spyOn(api, 'poolPage').mockImplementation(async (_site, _pool, number) => page(number));
    const { restoreScrollTo } = await import('@/features/file-detail/restoreScrollTo');
    const container = document.createElement('div');
    root = createRoot(container);
    await act(async () => root?.render(<PoolView />));
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Load more')))?.click();
    });
    expect(container.textContent).toContain('Page 2');

    vi.stubGlobal('scrollY', 740);
    act(() => window.dispatchEvent(new Event('scroll')));
    act(() => {
      (Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent === 'Page 1'))?.click();
    });
    vi.stubGlobal('scrollY', 0);
    act(() => window.dispatchEvent(new Event('scroll')));
    act(() => root?.unmount());
    root = createRoot(container);
    await act(async () => root?.render(<PoolView />));

    expect(container.textContent).toContain('Page 2');
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(restoreScrollTo).toHaveBeenCalledWith(740);
    vi.unstubAllGlobals();
  });
});
