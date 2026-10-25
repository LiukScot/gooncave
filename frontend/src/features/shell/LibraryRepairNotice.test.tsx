// @vitest-environment happy-dom

import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { LibraryRepairNotice } from './LibraryRepairNotice';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
notifyManager.setScheduler((notify) => notify());

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

const mount = async (running: boolean, percent = 0, hidden = false) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ running, percent }))));
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(<QueryClientProvider client={new QueryClient()}><LibraryRepairNotice hidden={hidden} /></QueryClientProvider>);
  });
  return container;
};

it('shows how far the repair has got while it runs', async () => {
  const container = await mount(true, 42);
  await vi.waitFor(() => expect(container.textContent).toContain('fixing some errors in the database: 42%'));
});

it('shows nothing when there is nothing to repair', async () => {
  const container = await mount(false);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(container.textContent).toBe('');
});

it('stays off a detail view while the repair runs', async () => {
  const container = await mount(true, 42, true);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(container.textContent).toBe('');
});
