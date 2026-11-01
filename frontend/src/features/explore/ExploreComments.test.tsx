// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { ExploreComments, FileComments } from './ExploreComments';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

let reportNear: (() => void) | null = null;
const stubObserver = (startsNear: boolean) => {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private readonly report: IntersectionObserverCallback) {}
    observe() {
      reportNear = () => this.report([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      if (startsNear) reportNear();
    }
    disconnect() {}
  });
};

const render = async (respond: () => Response, view = <ExploreComments post={{ siteId: 's', remoteId: '1' }} />, startsNear = true) => {
  stubObserver(startsNear);
  vi.stubGlobal('fetch', vi.fn(async () => respond()));
  const container = document.createElement('div');
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        {view}
      </QueryClientProvider>
    )
  );
  await settle();
  return container;
};

it('asks the site for comments only once they come near the screen', async () => {
  const respond = () => Response.json({
    supported: true,
    comments: [{ id: '1', author: 'Early', body: 'first', score: null, createdAt: null }]
  });
  const container = await render(respond, undefined, false);
  expect(fetch).not.toHaveBeenCalled();

  act(() => reportNear?.());
  await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain('Early')); });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('asks nothing for a post the site says has no comments', async () => {
  const view = <ExploreComments post={{ siteId: 's', remoteId: '1', commentCount: 0 }} />;
  const container = await render(() => Response.json({ supported: true, comments: [] }), view);
  expect(fetch).not.toHaveBeenCalled();
  expect(container.textContent).toBe('');
});

it('lists the comments with their author, score and Markdown text', async () => {
  const container = await render(() =>
    Response.json({
      supported: true,
      comments: [
        { id: '1', author: 'Early', body: '**first**', score: 3, createdAt: null },
        { id: '2', author: 'Later', body: '> quoted\nand ||hidden||', score: null, createdAt: null }
      ]
    })
  );
  expect(container.querySelector('.file-detail-section-title')?.textContent).toBe('Comments (2)');
  const authors = [...container.querySelectorAll('article .font-semibold')].map((e) => e.textContent);
  expect(authors).toEqual(['Early', 'Later']);
  expect(container.querySelector('strong')?.textContent).toBe('first');
  expect(container.textContent).toContain('Score 3');
  expect(container.querySelector('blockquote')?.textContent).toBe('quoted');
  expect(container.textContent).not.toContain('hidden');
});

it('shows nothing for a site that has no comments or a post with none', async () => {
  const none = await render(() => Response.json({ supported: false, comments: [] }));
  expect(none.textContent).toBe('');
  act(() => root?.unmount());
  const empty = await render(() => Response.json({ supported: true, comments: [] }));
  expect(empty.textContent).toBe('');
});

it('says why the comments did not load and tries again on Retry', async () => {
  let failing = true;
  const container = await render(() =>
    failing
      ? Response.json({ error: 'The site is down.' }, { status: 502 })
      : Response.json({
          supported: true,
          comments: [{ id: '1', author: 'Back', body: 'hello', score: null, createdAt: null }]
        })
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('The site is down.');
  failing = false;
  await act(async () => container.querySelector('button')?.click());
  await settle();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('Back');
});

it('lists the comments of the post a library file was saved from', async () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- types the call args
  const fetchMock = vi.fn(async (_url: string) =>
    Response.json({
      supported: true,
      comments: [{ id: '1', author: 'Early', body: 'hi', score: null, createdAt: null }]
    })
  );
  stubObserver(true);
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <FileComments fileId="file-1" />
      </QueryClientProvider>
    )
  );
  await settle();
  expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/files/file-1/comments');
  expect(container.textContent).toContain('Early');
});
