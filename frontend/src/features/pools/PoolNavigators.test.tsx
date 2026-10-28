// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PoolNavigators } from './PoolNavigators';

import type { PoolNavigator } from '@/api';
import { useExploreUiStore } from '@/stores/exploreUiStore';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, onClick }: React.ComponentProps<'a'>) => (
    <a onClick={onClick}>{children}</a>
  ),
  useLocation: ({ select }: { select: (s: { pathname: string }) => unknown }) =>
    select({ pathname })
}));

const showPost = vi.fn();
const explorePost = vi.fn();
let pathname = '/app/explore';

vi.mock('@/features/explore/useOpenBooruPost', () => ({
  useOpenExcursionPost: () => showPost
}));

vi.mock('@/api', () => ({
  api: { explorePost: (...args: unknown[]) => explorePost(...args) }
}));

const pool: PoolNavigator = {
  siteId: 'site',
  siteName: 'Site',
  poolId: 'pool',
  name: 'Pool',
  position: 2,
  postCount: 3,
  prevId: '1',
  nextId: '3'
};

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  useExploreUiStore.setState({
    excursionNav: null,
    poolOrigin: null,
    openLibraryAside: null
  });
  pathname = '/app/explore';
  vi.clearAllMocks();
});

describe('PoolNavigators', () => {
  it('keeps Gallery as the pool origin during a Gallery excursion', () => {
    useExploreUiStore.setState({
      excursionNav: {
        backLabel: 'Back to gallery',
        hasPrev: false,
        hasNext: false,
        goRelative: vi.fn(),
        close: vi.fn()
      }
    });
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root?.render(<PoolNavigators pools={[pool]} />));

    act(() => container.querySelector('a')?.click());

    expect(useExploreUiStore.getState().poolOrigin).toBe('/app/gallery');
  });

  const clickNext = async (container: HTMLElement) => {
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label^="Next page"]')
        ?.click();
    });
  };

  it('opens a saved page in Gallery when turning pages from a Gallery file', async () => {
    pathname = '/app/gallery';
    explorePost.mockResolvedValue({ post: { remoteId: '3', localFileId: 'f3' } });
    const openLibraryAside = vi.fn(async () => true);
    useExploreUiStore.setState({ openLibraryAside });
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root?.render(<PoolNavigators pools={[pool]} />));

    await clickNext(container);

    expect(openLibraryAside).toHaveBeenCalledWith('f3');
    expect(showPost).not.toHaveBeenCalled();
  });

  it('opens a page that is not saved in Explore, even from Gallery', async () => {
    pathname = '/app/gallery';
    explorePost.mockResolvedValue({ post: { remoteId: '3', localFileId: null } });
    const openLibraryAside = vi.fn(async () => true);
    useExploreUiStore.setState({ openLibraryAside });
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root?.render(<PoolNavigators pools={[pool]} />));

    await clickNext(container);

    expect(openLibraryAside).not.toHaveBeenCalled();
    expect(showPost).toHaveBeenCalled();
  });
});
