// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useFoldersController } from './useFoldersController';

import type { DeviceProfile, Folder } from '@/api';
import { queryKeys } from '@/lib/query-keys';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;
let client: QueryClient | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  client?.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('reloads once when a scan changed a folder, and not on a poll that brings nothing new', async () => {
  vi.useFakeTimers();
  const folder: Folder = {
    id: 'root', path: '/library', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    lastScanAt: '2026-01-01T00:00:00Z'
  };
  const profile: DeviceProfile = {
    id: 'owner', username: 'owner', libraryRoot: '/library', createdAt: '2026-01-01',
    updatedAt: '2026-01-01', lastLoginAt: null,
    capabilities: { library: true, boorus: false, processing: false }
  };
  let responseFolder = folder;
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ folders: [responseFolder] })));
  vi.stubGlobal('fetch', fetchMock);
  const finished = vi.fn();
  function Probe() {
    useFoldersController({
      authUser: profile, libraryRoot: '/library', onScanFinished: finished
    });
    return null;
  }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.folders.list(), [folder]);
  root = createRoot(document.createElement('div'));
  await act(async () => root?.render(<QueryClientProvider client={client!}><Probe /></QueryClientProvider>));
  await act(async () => vi.advanceTimersByTimeAsync(100));
  finished.mockClear();
  fetchMock.mockClear();
  responseFolder = { ...folder, lastScanAt: '2026-01-01T00:01:00Z' };
  await act(async () => vi.advanceTimersByTimeAsync(30_100));
  expect(fetchMock).toHaveBeenCalled();
  expect(finished).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(30_100));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(finished).toHaveBeenCalledTimes(1);
});
