// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { SubscriptionsSettings } from './SubscriptionsSettings';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
  useNavigate: () => vi.fn()
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error('Condition was not met');
};

const render = async () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <SubscriptionsSettings />
      </QueryClientProvider>
    );
  });
  return container;
};

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

it('shows a tag-save error beside the tag form', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return new Response(JSON.stringify({ error: 'Invalid tag list' }), {
        status: 400,
        statusText: 'Bad Request'
      });
    }
    return new Response(
      JSON.stringify({
        tags: [],
        artistSources: [
          { siteId: 'fa', siteName: 'FurAffinity', artists: [], error: null }
        ],
        targets: []
      }),
      { status: 200 }
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <SubscriptionsSettings />
      </QueryClientProvider>
    );
  });
  await waitFor(() => container.textContent?.includes('FurAffinity') ?? false);

  const textarea = container.querySelector('textarea');
  if (!textarea) throw new Error('Tag textarea was not rendered');
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    setValue?.call(textarea, 'red_fox');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const save = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Save searches'
  );
  if (!save) throw new Error('Save tags button was not rendered');
  await act(async () => save.click());
  await waitFor(() => container.textContent?.includes('Invalid tag list') ?? false);

  const sections = container.querySelectorAll('section');
  expect(sections[0]?.querySelector('label[for="subscription-tags"]')?.textContent).toBe(
    'One search per row'
  );
  expect(sections[0]?.textContent).toContain('Invalid tag list');
  expect(sections[1]?.textContent).not.toContain('Invalid tag list');
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/settings/subscriptions/tags',
    expect.objectContaining({ method: 'PUT' })
  );
});

it('removes only the search whose X was clicked, and lists followed pools', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PUT') {
      return new Response(init.body as string, { status: 200 });
    }
    if (url.endsWith('/settings/subscriptions/pools')) {
      return new Response(
        JSON.stringify({
          pools: [
            {
              siteId: 'e6',
              siteName: 'e621',
              poolId: '7',
              name: 'Fox Comic',
              postCount: 12,
              coverUrl: null
            }
          ]
        }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({ tags: ['red fox', 'wolf'], artistSources: [], targets: [] }),
      { status: 200 }
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const container = await render();
  await waitFor(() => container.textContent?.includes('Fox Comic') ?? false);
  expect(container.textContent).toContain('e621 · 12 pages');

  const remove = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Unsubscribe from red fox"]'
  );
  if (!remove) throw new Error('Remove button was not rendered');
  await act(async () => remove.click());

  const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(put?.[1]?.body as string)).toEqual({ tags: ['wolf'] });
});
