// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/features/pools/PoolNavigators', () => ({
  PoolNavigators: () => null
}));

import { ExploreDetailPanel } from './ExploreDetailPanel';

import type { ExplorePost } from '@/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

const post: ExplorePost = {
  remoteId: '123',
  previewUrl: 'https://t.furaffinity.net/123.jpg',
  sampleUrl: null,
  fileUrl: null,
  width: 100,
  height: 100,
  score: null,
  rating: null,
  md5: null,
  createdAt: null,
  tags: [],
  favCount: null,
  uploader: null,
  fileExt: 'png',
  fileSize: null,
  favorited: false,
  voted: null,
  siteId: 'fa',
  siteName: 'FurAffinity',
  engine: 'furaffinity',
  sourceUrl: 'https://www.furaffinity.net/view/123/',
  parentId: null,
  hasChildren: false,
  poolIds: []
};

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error('Condition was not met');
};

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

it('shows a failed full-resolution lookup and retries it', async () => {
  let detailAttempts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/explore/post-tags')) {
        detailAttempts += 1;
        if (detailAttempts === 1) {
          return new Response(JSON.stringify({ error: 'Temporary failure' }), {
            status: 503,
            statusText: 'Service Unavailable'
          });
        }
        return new Response(
          JSON.stringify({
            tags: [],
            fileUrl: 'https://d.furaffinity.net/art/artist/full.png'
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ bindings: {} }), { status: 200 });
    })
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ExploreDetailPanel
          post={post}
          prevPost={null}
          nextPost={null}
          supportsVote={false}
          canVote={false}
          canFavorite={false}
          favorited={false}
          voted={null}
          voteBusy={false}
          favoriteBusy={false}
          actionError={null}
          backLabel="Back"
          hasPrev={false}
          hasNext={false}
          onGoRelative={vi.fn()}
          onClose={vi.fn()}
          onVote={vi.fn()}
          onFavorite={vi.fn()}
          onSelectTag={vi.fn()}
          onOpenRelated={vi.fn()}
        />
      </QueryClientProvider>
    );
  });
  await waitFor(
    () => container.textContent?.includes('Temporary failure') ?? false
  );

  const retry = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Retry'
  );
  if (!retry) throw new Error('Retry button was not rendered');
  await act(async () => retry.click());
  await waitFor(
    () =>
      container.querySelector('img.file-detail-media')?.getAttribute('src') ===
      'https://d.furaffinity.net/art/artist/full.png'
  );

  expect(detailAttempts).toBe(2);
  expect(container.textContent).not.toContain('Temporary failure');
});
