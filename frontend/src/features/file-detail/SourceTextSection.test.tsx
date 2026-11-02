// @vitest-environment happy-dom

import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { SourceTextSection, useExplorePostText, useFileSourceText } from './SourceTextSection';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Query results reach the component on a later timer by default, after act() has returned.
notifyManager.setScheduler((notify) => notify());

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function FileText() {
  return <SourceTextSection {...useFileSourceText('f1')} />;
}

const render = async (answer: () => Response) => {
  const fetch = vi.fn(async () => answer());
  vi.stubGlobal('fetch', fetch);
  const container = document.createElement('div');
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(<QueryClientProvider client={client}><FileText /></QueryClientProvider>);
  });
  await act(async () => { await vi.waitFor(() => expect(fetch).toHaveBeenCalled()); });
  await act(async () => { await vi.waitFor(() => expect(client.isFetching()).toBe(0)); });
  return { container, fetch };
};

it('says the description could not be read and loads it again on request', async () => {
  let up = false;
  const { container, fetch } = await render(() => up
    ? new Response(JSON.stringify({ sources: [{ siteName: 'Booru', sourceUrl: 'https://booru.example/1', title: null, description: 'Fake text' }] }))
    : new Response(JSON.stringify({ error: 'down' }), { status: 502 }));
  expect(container.textContent).toContain('could not be read from the site');

  up = true;
  await act(async () => { container.querySelector('button')?.click(); });
  await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain('Fake text')); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain('could not be read');
});

it('says the description waits for a connection instead of blaming the site while offline', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const { container } = await render(() => new Response(JSON.stringify({ error: 'down' }), { status: 502 }));
  expect(container.textContent).toContain('when you reconnect');
  expect(container.textContent).not.toContain('could not be read');
  expect(container.querySelector('button')).toBeNull();
});

it('shows the text a search already brought without asking the site', async () => {
  const fetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const container = document.createElement('div');
  root = createRoot(container);
  const post = { siteId: 's', remoteId: '1', siteName: 'Booru', sourceUrl: 'https://booru.example/1', title: 'Fake title', description: 'Fake text' };
  const PostText = () => <SourceTextSection {...useExplorePostText(post)} />;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(<QueryClientProvider client={client}><PostText /></QueryClientProvider>);
  });
  expect(container.textContent).toContain('Fake title');
  expect(container.textContent).toContain('Fake text');
  expect(fetch).not.toHaveBeenCalled();
});

it('renders nothing when the file has no text', async () => {
  const { container } = await render(() => new Response(JSON.stringify({ sources: [] })));
  expect(container.textContent).toBe('');
});

const twoSources = [
  { siteName: 'e621', sourceUrl: 'https://e621.net/posts/1', title: null, description: 'from e621' },
  { siteName: 'Danbooru', sourceUrl: 'https://danbooru.donmai.us/posts/2', title: null, description: 'from danbooru' }
];

const show = async (sources: typeof twoSources) => {
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(<SourceTextSection sources={sources} failed={false} retrying={false} onRetry={() => undefined} />);
  });
  return container;
};

it('shows one icon per source side by side and switches the text on a tap', async () => {
  const container = await show(twoSources);
  const picks = Array.from(container.querySelectorAll<HTMLButtonElement>('.file-detail-source-pick'));
  expect(picks.map((button) => button.getAttribute('aria-label'))).toEqual(['e621', 'Danbooru']);
  expect(container.textContent).toContain('from e621');

  await act(async () => picks[1].click());
  expect(container.textContent).toContain('from danbooru');
  expect(picks[1].getAttribute('aria-pressed')).toBe('true');
});

it('shows no icons when there is a single source', async () => {
  const container = await show(twoSources.slice(0, 1));
  expect(container.textContent).toContain('from e621');
  expect(container.querySelector('.file-detail-source-pick')).toBeNull();
});
