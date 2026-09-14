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
        setBooruDevOptionsPersistent={vi.fn()}
      />
    )
  );

  act(() => container.querySelector('button')?.click());

  expect(runFavoritesSync).toHaveBeenCalledWith(false);
});
