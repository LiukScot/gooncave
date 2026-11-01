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
  vi.restoreAllMocks();
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

const POST = { siteId: 's', remoteId: '1', siteName: 'Site', sourceUrl: 'https://site.test/1' };

const render = async (respond: () => Response, view = <ExploreComments post={POST} />, startsNear = true) => {
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
  const view = <ExploreComments post={{ ...POST, commentCount: 0 }} />;
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

it('says the comments wait for a connection instead of failing while offline', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const container = await render(() => Response.json({ error: 'No connection.' }, { status: 502 }));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toContain('when you reconnect');
  expect(container.querySelector('button')).toBeNull();
});

const FILE_VIEW = <FileComments fileId="file-1" />;
const source = (siteName: string, author: string) => ({
  siteName,
  sourceUrl: `https://${siteName}.test/1`,
  comments: [{ id: '1', author, body: 'hi', score: null, createdAt: null }]
});

it('lists the comments of the post a library file was saved from', async () => {
  const container = await render(() => Response.json({ supported: true, sources: [source('one', 'Early')] }), FILE_VIEW);
  expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain('/files/file-1/comments');
  expect(container.textContent).toContain('Early');
  expect(container.querySelector('[aria-label="Comments source"]')).toBeNull();
});

it('switches between the sites of a file saved from several', async () => {
  const container = await render(
    () => Response.json({ supported: true, sources: [source('one', 'Early'), source('two', 'Later')] }),
    FILE_VIEW
  );
  const pick = (name: string) => container.querySelector<HTMLButtonElement>(`[aria-label="Comments source"] [aria-label="${name}"]`);
  expect(pick('one')?.getAttribute('aria-pressed')).toBe('true');
  expect(container.textContent).toContain('Early');
  expect(container.textContent).not.toContain('Later');
  await act(async () => pick('two')?.click());
  expect(pick('two')?.getAttribute('aria-pressed')).toBe('true');
  expect(container.textContent).toContain('Later');
  expect(container.textContent).not.toContain('Early');
});
