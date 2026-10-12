// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { SettingsLoadGate } from './SettingsLoadGate';

import { queryKeys } from '@/lib/query-keys';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

it('keeps an unsaved draft mounted when a background reload fails', async () => {
  let failed = false;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(failed ? { error: 'Check disk space.' } : { bindings: {} }), { status: failed ? 500 : 200 })));
  const container = document.createElement('div');
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root?.render(
    <QueryClientProvider client={client}>
      <SettingsLoadGate section="shortcuts"><input aria-label="Draft" defaultValue="saved" /></SettingsLoadGate>
    </QueryClientProvider>
  ));
  for (let attempt = 0; attempt < 20 && !container.querySelector('input'); attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  const input = container.querySelector('input')!;
  input.value = 'unsaved';
  failed = true;
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.settings.shortcuts() }); });
  for (let attempt = 0; attempt < 20 && !container.querySelector('[role="alert"]'); attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  expect(container.querySelector('input')).toBe(input);
  expect(input.value).toBe('unsaved');
  failed = false;
  await act(async () => container.querySelector('button')?.click());
  for (let attempt = 0; attempt < 20 && container.querySelector('[role="alert"]'); attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  expect(container.querySelector('input')).toBe(input);
  expect(input.value).toBe('unsaved');
  client.clear();
});

it('does not expose editable defaults when settings fail and lets the user retry', async () => {
  let failed = true;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(failed ? { error: 'Check disk space.' } : { bindings: {} }), { status: failed ? 500 : 200 })));
  const container = document.createElement('div');
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root?.render(
    <QueryClientProvider client={client}>
      <SettingsLoadGate section="shortcuts"><input aria-label="Saved setting" /></SettingsLoadGate>
    </QueryClientProvider>
  ));
  for (let attempt = 0; attempt < 20 && !container.querySelector('[role="alert"]'); attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  expect(container.querySelector('input')).toBeNull();
  expect(container.textContent).toContain('Check disk space.');
  failed = false;
  await act(async () => container.querySelector('button')?.click());
  for (let attempt = 0; attempt < 20 && !container.querySelector('input'); attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  expect(container.querySelector('input')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
