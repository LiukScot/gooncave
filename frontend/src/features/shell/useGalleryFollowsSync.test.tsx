// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useGalleryFollowsSync } from './useGalleryFollowsSync';

import type { FavoriteSyncStatus } from '@/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const scrollTo = (y: number) => {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
};

const sync = (status: FavoriteSyncStatus['status'], added: number, startedAt = 'run-1') =>
  ({
    status,
    message: '',
    startedAt,
    updatedAt: '',
    progress: { providers: [{ added }] },
    results: []
  }) as unknown as FavoriteSyncStatus;

const setup = () => {
  const showNew = vi.fn();
  const reload = vi.fn();
  function Probe({ status, showing }: { status: FavoriteSyncStatus; showing: boolean }) {
    useGalleryFollowsSync(status, showing, showNew, reload);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (status: FavoriteSyncStatus, showing = true) =>
    act(async () => root.render(<Probe status={status} showing={showing} />));
  return { showNew, reload, render, unmount: () => act(() => root.unmount()) };
};

afterEach(() => scrollTo(0));

it('shows new files as a running sync adds them, once per increase', async () => {
  const { showNew, reload, render, unmount } = setup();
  await render(sync('running', 0));
  expect(showNew).not.toHaveBeenCalled();
  await render(sync('running', 3));
  expect(showNew).toHaveBeenCalledTimes(1);
  await render(sync('running', 3));
  expect(showNew).toHaveBeenCalledTimes(1);
  await render(sync('running', 5));
  expect(showNew).toHaveBeenCalledTimes(2);
  expect(reload).not.toHaveBeenCalled();
  unmount();
});

it('holds new files back from a reader who scrolled, until they return to the top', async () => {
  const { showNew, render, unmount } = setup();
  scrollTo(900);
  await render(sync('running', 0));
  await render(sync('running', 2));
  expect(showNew).not.toHaveBeenCalled();
  scrollTo(0);
  await act(async () => window.dispatchEvent(new Event('scroll')));
  expect(showNew).toHaveBeenCalledTimes(1);
  unmount();
});

it('holds new files back while the gallery is not on screen', async () => {
  const { showNew, render, unmount } = setup();
  await render(sync('running', 0), false);
  await render(sync('running', 2), false);
  expect(showNew).not.toHaveBeenCalled();
  await render(sync('running', 2), true);
  expect(showNew).toHaveBeenCalledTimes(1);
  unmount();
});

it('reloads when a sync ends, keeping the place of a reader who scrolled', async () => {
  const { reload, render, unmount } = setup();
  await render(sync('running', 0));
  await render(sync('done', 0));
  expect(reload).toHaveBeenLastCalledWith(false);

  scrollTo(900);
  await render(sync('running', 0, 'run-2'));
  await render(sync('done', 0, 'run-2'));
  expect(reload).toHaveBeenCalledTimes(2);
  expect(reload).toHaveBeenLastCalledWith(true);
  unmount();
});

it('notices a run that started and ended between two readings of the status', async () => {
  const { reload, render, unmount } = setup();
  await render(sync('done', 0, 'run-1'));
  expect(reload).not.toHaveBeenCalled();
  await render(sync('done', 4, 'run-2'));
  expect(reload).toHaveBeenCalledTimes(1);
  await render(sync('done', 4, 'run-2'));
  expect(reload).toHaveBeenCalledTimes(1);
  unmount();
});
