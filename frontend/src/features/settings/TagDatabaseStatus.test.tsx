// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { TagDatabaseStatus } from './TagDatabaseStatus';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | null = null;
let client: QueryClient | null = null;

const settle = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error('Expected vocabulary state did not appear');
};

function render() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<QueryClientProvider client={client!}><TagDatabaseStatus /></QueryClientProvider>));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  client?.clear();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('keeps the previous vocabulary visible and queues a retry after a download failure', async () => {
  let queued = false;
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { queued = true; return Response.json({ status: 'queued' }); }
    return Response.json({ state: queued ? 'queued' : 'failed', importedAt: '2026-01-01T00:00:00Z', error: queued ? null : 'Check your connection. Previous vocabulary retained.' });
  }));
  render();
  await settle(() => document.body.textContent!.includes('Previous vocabulary retained.'));
  expect(document.body.textContent).toContain('Saved vocabulary available');
  act(() => document.querySelector('button')!.click());
  await settle(() => queued && document.querySelector('button')!.disabled);
  expect(document.body.textContent).toContain('Downloading');
});

it('shows a recoverable status error when the local core cannot be read', async () => {
  let available = false;
  vi.stubGlobal('fetch', vi.fn(async () => available ? Response.json({ state: 'waiting', importedAt: null, error: null }) :
    Response.json({ error: 'Check free disk space.' }, { status: 500 })));
  render();
  await settle(() => document.body.textContent!.includes('Check vocabulary again'));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Check free disk space.');
  available = true;
  act(() => document.querySelector('button')!.click());
  await settle(() => document.body.textContent!.includes('Vocabulary not downloaded yet.'));
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
