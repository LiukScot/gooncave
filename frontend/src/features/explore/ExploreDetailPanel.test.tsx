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
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  throw new Error('Condition was not met');
};

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

it('copies the remote post link from the info row', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText }
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ExploreDetailPanel
          post={{ ...post, fileUrl: 'https://d.furaffinity.net/full.png' }}
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

  const copyButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Copy post link"]'
  );
  if (!copyButton) throw new Error('Copy post link button was not rendered');
  await act(async () => copyButton.click());

  expect(writeText).toHaveBeenCalledWith(post.sourceUrl);
  expect(
    container.querySelector('button[aria-label="Post link copied"]')
  ).not.toBeNull();
});

it('keeps an optimistic favorite visibly active while the request is pending', async () => {
  const queryClient = new QueryClient();
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ExploreDetailPanel
          post={{ ...post, fileUrl: 'https://d.furaffinity.net/full.png' }}
          prevPost={null}
          nextPost={null}
          supportsVote={false}
          canVote={false}
          canFavorite
          favorited
          voted={null}
          voteBusy={false}
          favoriteBusy
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

  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Remove from favorites"]'
  );
  expect(button?.classList.contains('btn-primary')).toBe(true);
  expect(button?.disabled).toBe(false);
  expect(button?.getAttribute('aria-busy')).toBe('true');
});

it('keeps an optimistic automatic upvote selected while it is pending', async () => {
  const queryClient = new QueryClient();
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ExploreDetailPanel
          post={{ ...post, fileUrl: 'https://d.furaffinity.net/full.png' }}
          prevPost={null}
          nextPost={null}
          supportsVote
          canVote
          canFavorite
          favorited
          voted={1}
          voteBusy
          favoriteBusy
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

  const upvote = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Vote up"]'
  );
  expect(upvote?.disabled).toBe(true);
  expect(upvote?.getAttribute('aria-pressed')).toBe('true');
  expect(upvote?.classList.contains('file-detail-vote-up')).toBe(true);
});

it('shows a failed full-resolution lookup and retries it', async () => {
  const retryPost = {
    ...post,
    remoteId: 'retry-123',
    sourceUrl: 'https://www.furaffinity.net/view/retry-123/'
  };
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
          post={retryPost}
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
