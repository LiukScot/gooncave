// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { KeepOnDeviceButton } from './KeepOnDeviceButton';

import type { FileItem } from '@/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

const originals = (keepAll: boolean) => ({
  upload: false, keepAll, defaultKeepAll: true, folderConnected: false, localBytes: 0, status: {}
});

const render = async (keepAll: boolean, locationType: FileItem['locationType'], kept: boolean) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(JSON.stringify(String(url).endsWith('/keep') ? { kept } : originals(keepAll)))));
  const container = document.createElement('div');
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const file = { id: 'f1', locationType } as FileItem;
  await act(async () => {
    root?.render(<QueryClientProvider client={client}><KeepOnDeviceButton file={file} onKept={vi.fn()} /></QueryClientProvider>);
  });
  await act(async () => { await vi.waitFor(() => {
    expect(client.getQueryData(['originals'])).toBeDefined();
    if (!keepAll) expect(client.getQueryData(['files', 'f1', 'kept'])).toBeDefined();
  }); });
  return container.querySelector('button');
};

it('is not shown when the device keeps every file', async () => {
  expect(await render(true, 'REMOTE', false)).toBeNull();
});

it('says whether the original is on this device and whether it is kept', async () => {
  expect((await render(false, 'REMOTE', false))?.getAttribute('aria-label')).toBe('Not on this device. Download it and keep it here');
  act(() => root?.unmount());
  expect((await render(false, 'LOCAL', false))?.getAttribute('aria-label')).toContain('On this device for now');
  act(() => root?.unmount());
  const kept = await render(false, 'LOCAL', true);
  expect(kept?.getAttribute('aria-pressed')).toBe('true');
  expect(kept?.getAttribute('aria-label')).toContain('Downloaded and kept on this device');
});
