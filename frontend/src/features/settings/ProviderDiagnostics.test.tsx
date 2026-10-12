// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { ExtraSettings } from './ExtraSettings';
import { ProviderDiagnostics } from './ProviderDiagnostics';

import { EXTRA_SETTINGS_DEFAULTS } from '@/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

it('keeps reports unmounted until developer mode is enabled', async () => {
  let settings = { ...EXTRA_SETTINGS_DEFAULTS };
  let reportRequests = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/provider-diagnostics')) {
      reportRequests += 1;
      return new Response(JSON.stringify({ reports: [] }));
    }
    if (init?.method === 'PUT') settings = { ...settings, ...JSON.parse(String(init.body)) };
    return new Response(JSON.stringify(settings));
  }));
  const container = document.createElement('div');
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root?.render(<QueryClientProvider client={client}><ExtraSettings /></QueryClientProvider>));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(container.querySelector('#provider-reports-heading')).toBeNull();
  expect(reportRequests).toBe(0);
  const toggle = container.querySelector<HTMLInputElement>('#extra-developerMode');
  expect(toggle?.checked).toBe(false);
  await act(async () => toggle?.click());
  for (let attempt = 0; attempt < 20 && !container.querySelector('#provider-reports-heading'); attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  expect(container.querySelector('#provider-reports-heading')).not.toBeNull();
  expect(reportRequests).toBe(1);
  await act(async () => toggle?.click());
  expect(container.querySelector('#provider-reports-heading')).toBeNull();
});

it('shows storage failure instead of claiming no incidents and lets the user retry', async () => {
  let failed = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            failed
              ? {
                  error: 'Check server storage permissions and free space.'
                }
              : { reports: [] }
          ),
          { status: failed ? 503 : 200 }
        )
    )
  );
  const container = document.createElement('div');
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <ProviderDiagnostics />
      </QueryClientProvider>
    )
  );
  for (
    let attempt = 0;
    attempt < 20 && !container.querySelector('[role="alert"]');
    attempt += 1
  ) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Check server storage'
  );
  expect(container.textContent).not.toContain('No provider incidents');
  failed = false;
  await act(async () => container.querySelector('button')?.click());
  for (
    let attempt = 0;
    attempt < 20 && !container.textContent?.includes('No provider incidents');
    attempt += 1
  ) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('No provider incidents');
});
