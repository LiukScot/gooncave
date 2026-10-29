// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';

import { AutomaticTagging } from './AutomaticTagging';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));
const shownErrors = () => vi.mocked(toast.error).mock.calls.map(([message]) => message);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | null = null;
let client: QueryClient | null = null;
const baseline = { available: true, enabled: false, model: 'fixture-model', modelBytes: 388733784,
  downloadedBytes: 0, total: 2, completed: 0, failed: 0, error: null, state: 'idle' };

const settle = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error('Expected tagging state did not appear');
};

function render() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<QueryClientProvider client={client!}><AutomaticTagging /></QueryClientProvider>));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  client?.clear();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('shows the download size before consent and stops an active download', async () => {
  const writes: boolean[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const enabled = JSON.parse(init.body as string).enabled as boolean;
      writes.push(enabled);
      return Response.json({ ...baseline, enabled, state: enabled ? 'downloading' : 'idle', downloadedBytes: enabled ? 10000000 : 0 });
    }
    return Response.json(baseline);
  }));
  render();
  await settle(() => document.body.textContent!.includes('Enable tagging'));
  expect(document.body.textContent).toContain('388.7 MB');
  expect(writes).toEqual([]);
  act(() => document.querySelector('button')!.click());
  await settle(() => document.body.textContent!.includes('Downloading model:'));
  expect(document.querySelector('progress')?.value).toBe(10000000);
  act(() => document.querySelector('button')!.click());
  await settle(() => document.body.textContent!.includes('Automatic tagging is off.'));
  expect(writes).toEqual([true, false]);
});

it('shows backfill progress and a recoverable per-file failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...baseline, enabled: true,
    state: 'tagging', completed: 1, failed: 1, error: 'Cannot read this image. Existing tags were kept.' })));
  render();
  await settle(() => document.body.textContent!.includes('1 of 2 files tagged.'));
  expect(document.querySelector('progress')?.value).toBe(1);
  expect(shownErrors().join()).toContain('Existing tags were kept.');
  expect(document.body.textContent).toContain('Turn tagging off and on to retry.');
});

it('offers a status retry without starting a download after a connection failure', async () => {
  let reachable = false;
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).not.toBe('PUT');
    return reachable ? Response.json(baseline) : Response.json({ error: 'Cannot read tagging status.' }, { status: 500 });
  });
  vi.stubGlobal('fetch', fetch);
  render();
  await settle(() => document.body.textContent!.includes('Check tagging again'));
  reachable = true;
  act(() => document.querySelector('button')!.click());
  await settle(() => document.body.textContent!.includes('Enable tagging'));
});
