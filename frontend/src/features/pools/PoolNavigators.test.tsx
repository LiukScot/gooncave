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
  useLocation: () => '/app/explore'
}));

vi.mock('@/features/explore/useOpenBooruPost', () => ({
  useOpenExcursionPost: () => vi.fn()
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
  useExploreUiStore.setState({ excursionNav: null, poolOrigin: null });
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
});
