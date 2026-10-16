// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';

import { useFileImport } from './useFileImport';

vi.mock('sonner', () => ({ toast: { loading: vi.fn(() => 'pending'), success: vi.fn(), error: vi.fn() } }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const tell = (detail: unknown) => act(() => { window.dispatchEvent(new CustomEvent('gooncave-drop', { detail })); });

const mount = (folderId: string | null) => {
  const imported = vi.fn();
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const names = (init.body as FormData).getAll('files').map((file) => (file as File).name);
    return new Response(JSON.stringify({
      uploaded: names.filter((name) => name !== 'notes.txt').map((name) => ({ name, fileId: name })),
      rejected: names.filter((name) => name === 'notes.txt').map((name) => ({ name, reason: 'Unsupported file type' }))
    }));
  });
  vi.stubGlobal('fetch', fetchMock);
  function Probe() {
    const dragging = useFileImport(folderId, imported);
    return <input aria-label="search" data-dragging={dragging} />;
  }
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<Probe />));
  return { container, fetchMock, imported };
};

const paste = (target: EventTarget, files: File[]) => {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.assign(event, { clipboardData: { files } });
  target.dispatchEvent(event);
  return event;
};

it('adds pasted files to the folder and renames a copied screenshot so pastes do not clash', async () => {
  const { fetchMock, imported } = mount('root');
  const event = paste(document.body, [new File(['x'], 'image.png', { type: 'image/png' }), new File(['y'], 'cat.jpg')]);
  expect(event.defaultPrevented).toBe(true);
  await act(async () => { await vi.waitFor(() => expect(imported).toHaveBeenCalled()); });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toContain('/folders/root/uploads');
  const names = (init.body as FormData).getAll('files').map((file) => (file as File).name);
  expect(names[0]).toMatch(/^pasted-.+-1\.png$/);
  expect(names[1]).toBe('cat.jpg');
});

it('leaves a paste into a text field and a paste without files to the page', () => {
  const { container, fetchMock } = mount('root');
  expect(paste(container.querySelector('input')!, [new File(['x'], 'cat.jpg')]).defaultPrevented).toBe(false);
  expect(paste(document.body, []).defaultPrevented).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('does not take files while there is no folder to put them in', () => {
  const { fetchMock } = mount(null);
  expect(paste(document.body, [new File(['x'], 'cat.jpg')]).defaultPrevented).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('shows files the desktop app takes from a drop and refreshes the gallery once they are added', async () => {
  const { container, fetchMock, imported } = mount('root');
  tell({ state: 'over' });
  expect(container.querySelector('input')?.dataset.dragging).toBe('true');
  tell({ state: 'adding', count: 1 });
  expect(container.querySelector('input')?.dataset.dragging).toBe('false');
  tell({ state: 'done', result: { uploaded: [{ name: 'cat.jpg', fileId: 'f1' }], rejected: [] } });
  expect(imported).toHaveBeenCalledTimes(1);
  tell({ state: 'done', result: { uploaded: 'not a list' } });
  expect(imported).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('shows a desktop failure that follows a finished import as a message of its own', () => {
  mount('root');
  tell({ state: 'adding', count: 1 });
  expect(toast.loading).toHaveBeenCalledWith('Adding a file…');
  tell({ state: 'done', result: { uploaded: [{ name: 'cat.jpg', fileId: 'f1' }], rejected: [] } });
  expect(toast.success).toHaveBeenCalledWith('Added cat.jpg', { id: 'pending' });
  tell({ state: 'failed', error: 'the copied picture is empty' });
  expect(toast.error).toHaveBeenCalledWith('Files were not added: the copied picture is empty', { id: undefined });
});
