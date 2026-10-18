// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { FavoritesAccountsSettings } from './FavoritesAccountsSettings';

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
        booruDevOptions={false}
      />
    )
  );

  act(() => container.querySelector('button')?.click());

  expect(runFavoritesSync).toHaveBeenCalledWith(false);
});

const renderDone = (booruDevOptions: boolean) => {
  const container = document.createElement('div');
  root = createRoot(container);
  act(() =>
    root?.render(
      <FavoritesAccountsSettings
        favoritesSyncState={{ loading: false, error: null }}
        favoritesSyncStatus={{
          status: 'done', message: 'Done', startedAt: '2026-10-18T10:00:00Z', updatedAt: '2026-10-18T10:01:00Z',
          progress: {
            providers: [{ provider: 'e621', siteName: 'e621', stage: 'done', processed: 3, total: 3, added: 1, removed: 0, fetched: 3, skipped: 0, errors: [] }]
          },
          results: []
        }}
        favoritesProgress={null}
        favoritesSummary={['1 added', '0 removed']}
        favoritesErrors={[]}
        runFavoritesSync={vi.fn(async () => undefined)}
        cancelFavoritesSync={vi.fn()}
        booruDevOptions={booruDevOptions}
      />
    )
  );
  return container.textContent ?? '';
};

it('shows the result of a sync in short unless developer mode is on', () => {
  const short = renderDone(false);
  expect(short).toContain('1 added');
  expect(short).not.toContain('0 removed');
  expect(short).not.toContain('Last sync');
  expect(short).not.toContain('3/3');
  act(() => root?.unmount());
  const full = renderDone(true);
  expect(full).toContain('0 removed');
  expect(full).toContain('Last sync started');
  expect(full).toContain('3/3');
});
