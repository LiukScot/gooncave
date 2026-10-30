// @vitest-environment happy-dom

import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { SourceTextSection, useFileSourceText } from './SourceTextSection';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Query results reach the component on a later timer by default, after act() has returned.
notifyManager.setScheduler((notify) => notify());

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
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

it('renders nothing when the file has no text', async () => {
  const { container } = await render(() => new Response(JSON.stringify({ sources: [] })));
  expect(container.textContent).toBe('');
});
