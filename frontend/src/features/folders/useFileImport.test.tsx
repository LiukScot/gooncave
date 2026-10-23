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

const mount = (folderId: string | null, photos?: unknown) => {
  const imported = vi.fn();
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/photos/add')) return new Response(JSON.stringify(photos));
    const names = (init.body as FormData).getAll('files').map((file) => (file as File).name);
    return new Response(JSON.stringify({
      uploaded: names.filter((name) => name !== 'notes.txt').map((name) => ({ name, fileId: name })),
      rejected: names.filter((name) => name === 'notes.txt').map((name) => ({ name, reason: 'Unsupported file type' }))
    }));
  });
  vi.stubGlobal('fetch', fetchMock);
  function Probe() {
    const { dragging, addFromPhotos } = useFileImport(folderId, imported);
    return <input aria-label="search" data-dragging={dragging} onClick={addFromPhotos} />;
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

it('says why files are not added while there is no folder to put them in', () => {
  const { container, fetchMock } = mount(null);
  expect(paste(document.body, [new File(['x'], 'cat.jpg')]).defaultPrevented).toBe(true);
  drag('dragenter', []);
  expect(container.querySelector('input')?.dataset.dragging).toBe('false');
  expect(drag('drop', [new File(['x'], 'cat.jpg')]).defaultPrevented).toBe(true);
  act(() => container.querySelector('input')!.click());
  expect(toast.error).toHaveBeenCalledTimes(3);
  expect(vi.mocked(toast.error).mock.calls[0][0]).toMatch(/library is still loading/);
  expect(fetchMock).not.toHaveBeenCalled();
});

const drag = (type: string, files: File[], types = ['Files'], target: EventTarget = window) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { dataTransfer: { types, files, dropEffect: 'none' } });
  act(() => { target.dispatchEvent(event); });
  return event;
};

it('shows where dropped files land and adds them to the folder', async () => {
  const { container, fetchMock, imported } = mount('root');
  drag('dragenter', []);
  expect(container.querySelector('input')?.dataset.dragging).toBe('true');
  expect(drag('drop', [new File(['x'], 'cat.jpg')]).defaultPrevented).toBe(true);
  expect(container.querySelector('input')?.dataset.dragging).toBe('false');
  await act(async () => { await vi.waitFor(() => expect(imported).toHaveBeenCalled()); });
  const names = (fetchMock.mock.calls[0][1].body as FormData).getAll('files').map((file) => (file as File).name);
  expect(names).toEqual(['cat.jpg']);
  expect(toast.success).toHaveBeenCalledWith('Added cat.jpg', { id: 'pending' });
});

it('ignores a picture dragged from the page itself', () => {
  const { container, fetchMock } = mount('root');
  drag('dragstart', []);
  drag('dragenter', []);
  expect(container.querySelector('input')?.dataset.dragging).toBe('false');
  expect(drag('drop', [new File(['x'], 'cat.jpg')]).defaultPrevented).toBe(false);
  drag('dragend', []);
  drag('dragenter', []);
  expect(container.querySelector('input')?.dataset.dragging).toBe('true');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('still takes files after a page drag that never started, like panning a zoomed picture', () => {
  const { container } = mount('root');
  const picture = document.createElement('img');
  document.body.append(picture);
  picture.addEventListener('dragstart', (event) => event.preventDefault());
  // A cancelled drag never ends, so no dragend follows.
  drag('dragstart', [], ['Files'], picture);
  drag('dragenter', []);
  expect(container.querySelector('input')?.dataset.dragging).toBe('true');
  picture.remove();
});

it('keeps a dropped link from replacing the app and says only files can be added', () => {
  const { container, fetchMock } = mount('root');
  expect(drag('dragover', [], ['text/uri-list']).defaultPrevented).toBe(true);
  expect(drag('drop', [], ['text/uri-list']).defaultPrevented).toBe(true);
  expect(vi.mocked(toast.error).mock.calls[0][0]).toMatch(/Only files can be added/);
  expect(container.querySelector('input')?.dataset.dragging).toBe('false');
  // Text dropped into a field stays the field's.
  const field = container.querySelector('input')!;
  expect(drag('drop', [], ['text/plain'], field).defaultPrevented).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it('shows files the iPhone app takes from the share sheet and refreshes the gallery once they are added', async () => {
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

it('shows a share sheet failure that follows a finished import as a message of its own', () => {
  mount('root');
  tell({ state: 'adding', count: 1 });
  expect(toast.loading).toHaveBeenCalledWith('Adding a file…');
  tell({ state: 'done', result: { uploaded: [{ name: 'cat.jpg', fileId: 'f1' }], rejected: [] } });
  expect(toast.success).toHaveBeenCalledWith('Added cat.jpg', { id: 'pending' });
  tell({ state: 'failed', error: 'the copied picture is empty' });
  expect(toast.error).toHaveBeenCalledWith('Files were not added: the copied picture is empty', { id: undefined });
});

it('adds the photos picked from the library and says how many originals iOS deleted', async () => {
  const { container, fetchMock, imported } = mount('root', {
    uploaded: [{ name: 'a.jpg', fileId: 'f1' }, { name: 'b.jpg', fileId: 'f2' }],
    rejected: [],
    deleted: 2
  });
  act(() => container.querySelector('input')!.click());
  await act(async () => { await vi.waitFor(() => expect(imported).toHaveBeenCalled()); });
  expect(fetchMock.mock.calls[0][0]).toContain('/photos/add');
  expect(toast.success).toHaveBeenCalledWith('Added 2 files', { id: undefined });
  expect(toast.success).toHaveBeenCalledWith('Deleted 2 originals from Photos');
});

it('keeps the originals and says why when iOS did not delete them', async () => {
  const { container, imported } = mount('root', {
    uploaded: [{ name: 'a.jpg', fileId: 'f1' }],
    rejected: [],
    deleted: 0,
    deleteError: 'The operation was cancelled'
  });
  act(() => container.querySelector('input')!.click());
  await act(async () => { await vi.waitFor(() => expect(imported).toHaveBeenCalled()); });
  expect(toast.error).toHaveBeenCalledWith('The originals were not deleted from Photos: The operation was cancelled');
});
