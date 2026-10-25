// @vitest-environment happy-dom

import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useLibraryRepairNotice } from './useLibraryRepairNotice';

const toast = vi.hoisted(() => ({ info: vi.fn(), dismiss: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
notifyManager.setScheduler((notify) => notify());

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function Probe() {
  useLibraryRepairNotice();
  return null;
}

const mount = async (running: boolean, percent = 0) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ running, percent }))));
  root = createRoot(document.createElement('div'));
  const client = new QueryClient();
  await act(async () => {
    root?.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  });
};

it('tells the reader the database is being fixed while the repair runs', async () => {
  await mount(true, 42);
  await vi.waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('fixing some errors in the database: 42%'), expect.anything()));
});

it('stays silent when there is nothing to repair', async () => {
  await mount(false);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(toast.info).not.toHaveBeenCalled();
  expect(toast.dismiss).not.toHaveBeenCalled();
});
