// @vitest-environment happy-dom

import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { FavoriteLinksCheck } from './FavoriteLinksCheck';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
notifyManager.setScheduler((notify) => notify());

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

const open = async (response: Response) => {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div');
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await act(async () => {
    root?.render(<QueryClientProvider client={client}><FavoriteLinksCheck /></QueryClientProvider>);
  });
  await act(async () => {
    container.querySelector('button')?.click();
  });
  await act(async () => { await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled()); });
  return container;
};

it('names the links it removed and what it could not read', async () => {
  const container = await open(new Response(JSON.stringify({
    checked: 5, removed: [{ provider: 'E621', remoteId: '42' }], unchecked: 1, unresolvedFiles: 0
  })));
  await vi.waitFor(() => expect(container.textContent).toContain('removed 1: E621 #42'));
  expect(container.textContent).toContain('1 could not be read');
});

it('says so when the check fails', async () => {
  const container = await open(new Response(JSON.stringify({ error: 'The site could not be reached.' }), { status: 502 }));
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not finish'));
});
