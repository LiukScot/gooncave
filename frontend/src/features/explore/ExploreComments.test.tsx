// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { ExploreComments } from './ExploreComments';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

const render = async (respond: () => Response) => {
  vi.stubGlobal('fetch', vi.fn(async () => respond()));
  const container = document.createElement('div');
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <ExploreComments post={{ siteId: 's', remoteId: '1' }} />
      </QueryClientProvider>
    )
  );
  await settle();
  return container;
};

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

it('shows nothing for a site that has no comments, and a note for an empty thread', async () => {
  const none = await render(() => Response.json({ supported: false, comments: [] }));
  expect(none.innerHTML).toBe('');
  act(() => root?.unmount());
  const empty = await render(() => Response.json({ supported: true, comments: [] }));
  expect(empty.textContent).toContain('No comments yet.');
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
