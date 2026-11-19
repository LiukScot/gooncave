import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exploreDetailTags: vi.fn(),
  explorePostText: vi.fn(),
  exploreRelations: vi.fn()
}));

vi.mock('@/api', () => ({ api: mocks, API_BASE: '/api' }));

import { prefetchNeighbors } from './prefetchNeighbors';

import type { ExplorePost } from '@/api';
import { queryKeys } from '@/lib/query-keys';

const neighbor = (overrides: Partial<ExplorePost>): ExplorePost =>
  ({
    siteId: 'e621',
    remoteId: '2',
    tags: [{ tag: 'fox', category: 'species' }],
    parentId: null,
    hasChildren: false,
    ...overrides
  }) as ExplorePost;

afterEach(() => vi.clearAllMocks());

describe('prefetchNeighbors', () => {
  it('loads the next post’s description, related posts and site tags before it opens', async () => {
    mocks.explorePostText.mockResolvedValue({ title: null, description: 'hi' });
    mocks.exploreRelations.mockResolvedValue({ posts: [] });
    mocks.exploreDetailTags.mockResolvedValue({ tags: [], fileUrl: null });
    const client = new QueryClient();
    prefetchNeighbors(client, [
      neighbor({ remoteId: '2', parentId: '1', tags: [{ tag: 'fox', category: 'general' }] }),
      null
    ]);
    await vi.waitFor(() =>
      expect(client.getQueryData(queryKeys.explorePostText('e621', '2'))).toEqual({
        title: null,
        description: 'hi'
      })
    );
    expect(mocks.exploreRelations).toHaveBeenCalledOnce();
    expect(mocks.exploreDetailTags).toHaveBeenCalledWith('e621', '2');
  });

  it('asks nothing the search answer already holds', () => {
    prefetchNeighbors(new QueryClient(), [neighbor({ remoteId: '3', description: 'known' })]);
    expect(mocks.explorePostText).not.toHaveBeenCalled();
    expect(mocks.exploreRelations).not.toHaveBeenCalled();
    expect(mocks.exploreDetailTags).not.toHaveBeenCalled();
  });
});
