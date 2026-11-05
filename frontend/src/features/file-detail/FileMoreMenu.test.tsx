// @vitest-environment happy-dom

import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { FileMoreMenu } from './FileMoreMenu';

import type { FileItem } from '@/api';
import { DEFAULT_APPEARANCE, useAppearanceStore } from '@/stores/appearanceStore';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Query results reach the component on a later timer by default, after act() has returned.
notifyManager.setScheduler((notify) => notify());

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

// Sharing in the panel, which is where most of these tests look for it.
beforeEach(() => {
  useAppearanceStore.setState({ quickActions: { ...DEFAULT_APPEARANCE.quickActions, file: 'vote' } });
});

const originals = (keepAll: boolean) => ({
  upload: false, keepAll, defaultKeepAll: true, folderConnected: false, localBytes: 0, status: {}
});

const openMenu = async (
  keepAll: boolean,
  locationType: FileItem['locationType'],
  kept: boolean,
  { onKept = vi.fn(), onDelete = vi.fn(), onShare = vi.fn(), vote = null as ReactNode } = {}
) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return new Response(JSON.stringify({ kept: false, locationType: 'REMOTE' }));
    return new Response(JSON.stringify(String(url).endsWith('/keep') ? { kept } : originals(keepAll)));
  }));
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const file = { id: 'f1', locationType } as FileItem;
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <FileMoreMenu file={file} vote={vote} onKept={onKept} deleting={false} deleteTitle="Delete file" onDelete={onDelete} onShare={onShare} />
      </QueryClientProvider>
    );
  });
  await act(async () => { await vi.waitFor(() => {
    expect(client.getQueryData(['originals'])).toBeDefined();
    if (!keepAll) expect(client.getQueryData(['files', 'f1', 'kept'])).toBeDefined();
  }); });
  await act(async () => {
    container.ownerDocument.querySelector<HTMLButtonElement>('[aria-label="More actions"]')?.click();
  });
  return () => [...document.querySelectorAll<HTMLElement>('.search-panel .panel-pill')];
};

it('offers only deleting and sharing when the device keeps every file', async () => {
  const items = await openMenu(true, 'REMOTE', false);
  expect(items().map((item) => item.textContent)).toEqual(['Share', 'Delete file']);
});

it('puts the chosen quick action in the corner and the vote in the panel', async () => {
  useAppearanceStore.setState({ quickActions: { ...DEFAULT_APPEARANCE.quickActions, file: 'share' } });
  const onShare = vi.fn();
  const items = await openMenu(false, 'LOCAL', true, { onShare, vote: <button aria-label="Vote up" /> });
  expect(items().map((item) => item.textContent)).toEqual(['Remove from device', 'Delete file']);
  expect(document.querySelector('.search-panel [aria-label="Vote up"]')).not.toBeNull();
  await act(async () => { document.querySelector<HTMLButtonElement>('.file-detail-overlay-btn[aria-label="Share"]')?.click(); });
  expect(onShare).toHaveBeenCalledOnce();
});

it('keeps deleting as the lowest option, and opens sharing from its own item', async () => {
  const onShare = vi.fn();
  const items = await openMenu(false, 'LOCAL', true, { onShare });
  expect(items().map((item) => item.textContent)).toEqual(['Remove from device', 'Share', 'Delete file']);
  await act(async () => { items()[1].click(); });
  expect(onShare).toHaveBeenCalledOnce();
});

it('says whether the original is on this device and whether it is kept', async () => {
  const label = async (...state: [FileItem['locationType'], boolean]) => {
    const items = await openMenu(false, ...state);
    const text = items()[0].textContent;
    act(() => root?.unmount());
    document.body.innerHTML = '';
    return text;
  };
  expect(await label('REMOTE', false)).toBe('Keep on device');
  expect(await label('LOCAL', false)).toBe('Keep on device');
  expect(await label('LOCAL', true)).toBe('Remove from device');
});

it('shows the cloud until the file is kept, even when the original is here for now', async () => {
  const icon = async (...state: [FileItem['locationType'], boolean]) => {
    const items = await openMenu(false, ...state);
    const name = items()[0].querySelector('svg')?.getAttribute('class');
    act(() => root?.unmount());
    document.body.innerHTML = '';
    return name;
  };
  expect(await icon('REMOTE', false)).toContain('lucide-cloud-download');
  expect(await icon('LOCAL', false)).toContain('lucide-cloud-download');
  expect(await icon('LOCAL', true)).toContain('lucide-hard-drive');
});

it('reports where the original is once the person stops keeping a file', async () => {
  const onKept = vi.fn();
  const items = await openMenu(false, 'LOCAL', true, { onKept });
  await act(async () => { items()[0].click(); });
  await act(async () => { await vi.waitFor(() => expect(onKept).toHaveBeenCalledWith('f1', 'REMOTE')); });
});

it('closes the menu once the answer is known, so the message covers none of its items', async () => {
  const items = await openMenu(false, 'LOCAL', true);
  await act(async () => { items()[0].click(); });
  await act(async () => { await vi.waitFor(() => expect(items()).toEqual([])); });
});

it('asks to delete from its own item', async () => {
  const onDelete = vi.fn();
  const items = await openMenu(true, 'LOCAL', false, { onDelete });
  await act(async () => { items().at(-1)!.click(); });
  expect(onDelete).toHaveBeenCalledOnce();
});
