// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const queueLoadedReads = vi.hoisted(() => vi.fn());
vi.mock('@/features/read-marks/readQueue', () => ({ queueLoadedReads }));

import { ExploreReadFooter } from './ExploreReadFooter';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  queueLoadedReads.mockReset();
});

it('marks the loaded Popular page even when Unread only is off', () => {
  const loadMore = vi.fn(async () => []);
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root?.render(
    <ExploreReadFooter
      posts={[{ siteId: 'site', siteName: 'Site', remoteId: '1' }, { siteId: 'site', siteName: 'Site', remoteId: '2' }]}
      hasMore
      readHidden={false}
      readTrackingEnabled
      unreadOnly={false}
      loading={false}
      onLoadMore={loadMore}
      onMarkLoadedRead={vi.fn()}
    />
  ));

  act(() => container.querySelector('button')?.click());
  expect(queueLoadedReads).toHaveBeenCalledWith('Load more', [
    { siteId: 'site', siteName: 'Site', remoteId: '1' },
    { siteId: 'site', siteName: 'Site', remoteId: '2' }
  ]);
  expect(loadMore).toHaveBeenCalledOnce();
});

it('offers completion on the last unread page', () => {
  const markLoadedRead = vi.fn();
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root?.render(
    <ExploreReadFooter
      posts={[{ siteId: 'site', siteName: 'Site', remoteId: '1' }]}
      hasMore={false}
      readHidden={false}
      readTrackingEnabled
      unreadOnly
      loading={false}
      onLoadMore={vi.fn(async () => [])}
      onMarkLoadedRead={markLoadedRead}
    />
  ));

  act(() => container.querySelector('button')?.click());
  expect(markLoadedRead).toHaveBeenCalledOnce();
});

it('loads more without marking posts when read tracking is off', () => {
  const loadMore = vi.fn(async () => []);
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root?.render(
    <ExploreReadFooter
      posts={[{ siteId: 'site', siteName: 'Site', remoteId: '1' }]}
      hasMore
      readHidden={false}
      readTrackingEnabled={false}
      unreadOnly={false}
      loading={false}
      onLoadMore={loadMore}
      onMarkLoadedRead={vi.fn()}
    />
  ));

  act(() => container.querySelector('button')?.click());
  expect(queueLoadedReads).not.toHaveBeenCalled();
  expect(loadMore).toHaveBeenCalledOnce();
});
