// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { FavoritesAccountsSettings } from './FavoritesAccountsSettings';

import type { FavoriteSyncStatus } from '@/api';

vi.mock('@/BooruSitesPanel', () => ({ BooruSitesPanel: () => null }));
vi.mock('@/features/booru-sites/BooruEngineSupportTable', () => ({
  BooruEngineSupportTable: () => null
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

it('keeps local files when a remote favorite is missing during sync', () => {
  const runFavoritesSync = vi.fn(async () => undefined);
  const container = document.createElement('div');
  root = createRoot(container);
  act(() =>
    root?.render(
      <FavoritesAccountsSettings
        favoritesSyncState={{ loading: false, error: null }}
        favoritesSyncStatus={null}
        favoritesProgress={null}
        favoritesSummary={[]}
        favoritesErrors={[]}
        runFavoritesSync={runFavoritesSync}
        cancelFavoritesSync={vi.fn()}
        developerMode={false}
      />
    )
  );

  act(() => container.querySelector('button')?.click());

  expect(runFavoritesSync).toHaveBeenCalledWith(false);
});

const finishedSync: FavoriteSyncStatus = {
  status: 'done',
  message: 'Done',
  startedAt: '2026-10-16T10:00:00.000Z',
  updatedAt: '2026-10-16T10:05:00.000Z',
  progress: null,
  results: [
    { provider: 'e621', siteName: 'e621', added: 3, removed: 1, skipped: 7, fetched: 11, errors: [] },
    { provider: 'danbooru', siteName: 'Danbooru', added: 2, removed: 0, skipped: 4, fetched: 6, errors: ['Rate limited'] }
  ]
};

const renderFinished = (developerMode: boolean) => {
  const container = document.createElement('div');
  root = createRoot(container);
  act(() =>
    root?.render(
      <FavoritesAccountsSettings
        favoritesSyncState={{ loading: false, error: null }}
        favoritesSyncStatus={finishedSync}
        favoritesProgress={null}
        favoritesSummary={['e621: 3 added, 1 removed, 7 skipped, 11 fetched']}
        favoritesErrors={['Danbooru: Rate limited']}
        runFavoritesSync={vi.fn()}
        cancelFavoritesSync={vi.fn()}
        developerMode={developerMode}
      />
    )
  );
  return container.textContent ?? '';
};

it('sums up the last sync in one line and keeps its errors', () => {
  const text = renderFinished(false);
  expect(text).toContain('5 added, 1 removed');
  expect(text).toContain('Danbooru: Rate limited');
  expect(text).not.toContain('skipped');
  expect(text).not.toContain('Last sync started');
});

it('shows every site and timestamp in developer mode', () => {
  const text = renderFinished(true);
  expect(text).toContain('e621: 3 added, 1 removed, 7 skipped, 11 fetched');
  expect(text).toContain('Last sync started');
});
