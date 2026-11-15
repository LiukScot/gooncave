// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';

import { SubscriptionsSettings } from './SubscriptionsSettings';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));

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

it('shows a tag-save error as a toast and leaves the form alone', async () => {
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
        artists: [],
        artistErrors: [
          { siteId: 'fa', siteName: 'FurAffinity', error: 'Session expired.' }
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
  await waitFor(() => container.textContent?.includes('could not be synced') ?? false);

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
  await waitFor(() => vi.mocked(toast.error).mock.calls.length > 0);

  const sections = container.querySelectorAll('section');
  expect(sections[0]?.querySelector('label[for="subscription-tags"]')?.textContent).toBe(
    'One search per row'
  );
  expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toContain('Invalid tag list');
  expect(sections[0]?.textContent).not.toContain('Invalid tag list');
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
      JSON.stringify({
        tags: ['red fox', 'wolf'],
        artists: ['rukis'],
        artistErrors: [],
        targets: []
      }),
      { status: 200 }
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const container = await render();
  await waitFor(() => container.textContent?.includes('Fox Comic') ?? false);
  expect(container.textContent).toContain('e621 · 12 pages');
  const rowTitles = Array.from(container.querySelectorAll('.subscription-row-title')).map(
    (node) => node.textContent
  );
  expect(rowTitles).toEqual(['red fox', 'wolf', 'rukis', 'Fox Comic']);
  expect(container.querySelector('button[aria-label="Unfollow rukis"]')).not.toBeNull();

  const remove = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Unsubscribe from red fox"]'
  );
  if (!remove) throw new Error('Remove button was not rendered');
  await act(async () => remove.click());

  const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(put?.[1]?.body as string)).toEqual({ tags: ['wolf'] });
});

const setValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const subscriptionsFetch = () =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      return Response.json({ tags: ['red fox', 'wolf'], artists: ['rukis', 'nawka'] });
    }
    if (url.endsWith('/settings/subscriptions/pools')) {
      return Response.json({
        pools: [
          { siteId: 'e6', siteName: 'e621', poolId: '7', name: 'Fox Comic', postCount: 12, coverUrl: null }
        ]
      });
    }
    if (url.endsWith('/settings/subscriptions')) {
      return Response.json({
        tags: ['red fox', 'wolf'],
        artists: ['rukis', 'nawka'],
        siteHits: { 'red fox': ['e6'], wolf: ['e6', 'fa'], rukis: ['fa'] },
        artistErrors: [],
        targets: []
      });
    }
    if (url.endsWith('/booru-sites')) {
      return Response.json({
        sites: [
          { id: 'e6', name: 'e621', engine: 'e621', baseUrl: 'https://e621.net', enabled: true },
          { id: 'fa', name: 'FurAffinity', engine: 'furaffinity', baseUrl: 'https://www.furaffinity.net', enabled: true }
        ]
      });
    }
    return Response.json({ tags: [], suggestions: [] });
  });

it('subscribes from one input and shows the sites where each entry has results', async () => {
  const fetchMock = subscriptionsFetch();
  vi.stubGlobal('fetch', fetchMock);
  const container = await render();
  await waitFor(() => container.textContent?.includes('Fox Comic') ?? false);
  expect(container.querySelector('input[placeholder="Artist username"]')).toBeNull();
  await waitFor(() => container.querySelectorAll('.subscription-row [role="img"]').length > 0);
  const logos = (title: string) =>
    Array.from(
      Array.from(container.querySelectorAll('.subscription-row'))
        .find((row) => row.querySelector('.subscription-row-title')?.textContent === title)
        ?.querySelectorAll('[role="img"]') ?? []
    ).map((node) => node.getAttribute('aria-label'));
  expect(logos('red fox')).toEqual(['e621']);
  expect(logos('wolf')).toEqual(['e621', 'FurAffinity']);
  expect(logos('rukis')).toEqual(['FurAffinity']);
  expect(logos('nawka')).toEqual([]);

  const input = container.querySelector<HTMLInputElement>('#subscription-new-search');
  if (!input) throw new Error('Search input was not rendered');
  await act(async () => setValue(input, '  Newone  '));
  const subscribe = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Subscribe'
  );
  expect(subscribe?.disabled).toBe(false);
  await act(async () => input.form?.requestSubmit());
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(post?.[1]?.body as string)).toEqual({ search: 'newone' });
});

it('filters the list by name and by site', async () => {
  vi.stubGlobal('fetch', subscriptionsFetch());
  const container = await render();
  await waitFor(() => container.textContent?.includes('Fox Comic') ?? false);
  const titles = () =>
    Array.from(container.querySelectorAll('.subscription-row-title')).map((n) => n.textContent);
  expect(titles()).toEqual(['red fox', 'wolf', 'rukis', 'nawka', 'Fox Comic']);

  await act(async () => document.querySelector<HTMLButtonElement>('.search-lens')?.click());
  const filter = document.querySelector<HTMLInputElement>('input[name="subscription-filter"]');
  if (!filter) throw new Error('Filter field was not rendered');
  await act(async () => setValue(filter, 'FOX'));
  expect(titles()).toEqual(['red fox', 'Fox Comic']);

  await waitFor(() => document.querySelectorAll('.panel-pills button').length === 2);
  const site = (label: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.panel-pills button')).find(
      (button) => button.textContent === label
    );
  await act(async () => site('e621')?.click());
  expect(titles()).toEqual([]);
  await act(async () => site('e621')?.click());
  await act(async () => site('FurAffinity')?.click());
  expect(titles()).toEqual(['red fox', 'Fox Comic']);
  await act(async () => site('e621')?.click());
  expect(titles()).toEqual([]);
  expect(container.textContent).toContain('Nothing followed matches these filters.');

  await act(async () => site('e621')?.click());
  await act(async () => site('FurAffinity')?.click());
  await act(async () => setValue(filter, ''));
  expect(titles()).toEqual(['red fox', 'wolf', 'rukis', 'nawka', 'Fox Comic']);
});
