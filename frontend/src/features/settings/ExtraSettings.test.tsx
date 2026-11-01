// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { ExtraSettings } from './ExtraSettings';

import { EXTRA_SETTINGS_DEFAULTS } from '@/api';
import { ConfirmProvider } from '@/components/confirm-dialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

it('deletes the history only after turning History off is confirmed', async () => {
  let settings = { ...EXTRA_SETTINGS_DEFAULTS, readTrackingEnabled: true };
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
    if (String(input).endsWith('/tagging')) {
      return Response.json({ available: false, enabled: false, model: 'fixture', modelBytes: 0,
        downloadedBytes: 0, total: 0, completed: 0, failed: 0, error: null, state: 'idle' });
    }
    if (String(input).includes('/read-marks')) return Response.json({ cleared: 3 });
    if (init?.method === 'PUT') settings = { ...settings, ...JSON.parse(String(init.body)) };
    return new Response(JSON.stringify(settings));
  }));
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root?.render(<QueryClientProvider client={client}><ConfirmProvider><ExtraSettings /></ConfirmProvider></QueryClientProvider>));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const toggle = () => container.querySelector<HTMLInputElement>('#extra-readTrackingEnabled');
  expect(toggle()?.checked).toBe(true);

  const answer = async (label: string) => {
    await act(async () => toggle()?.click());
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
    await act(async () => button?.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  };
  await answer('Cancel');
  expect(requests.some((request) => request.startsWith('DELETE'))).toBe(false);
  expect(settings.readTrackingEnabled).toBe(true);

  await answer('Turn off and delete');
  expect(requests).toContain('DELETE /api/read-marks?scope=post');
  expect(settings.readTrackingEnabled).toBe(false);
  container.remove();
});
