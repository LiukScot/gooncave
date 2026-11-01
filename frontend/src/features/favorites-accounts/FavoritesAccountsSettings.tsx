import type { FavoriteSyncStatus } from '@/api';
import { BooruSitesPanel } from '@/BooruSitesPanel';
import { BooruEngineSupportTable } from '@/features/booru-sites/BooruEngineSupportTable';
import { formatDateTime } from '@/lib/format';

type FetchState = { loading: boolean; error: string | null };

export interface FavoritesAccountsSettingsProps {
  favoritesAvailable?: boolean;
  favoritesSyncState: FetchState;
  favoritesSyncStatus: FavoriteSyncStatus | null;
  favoritesProgress: number | null;
  favoritesErrors: string[];
  runFavoritesSync: (deleteMissing: boolean) => Promise<void>;
  cancelFavoritesSync: () => Promise<void>;
}

export function FavoritesAccountsSettings({
  favoritesAvailable = true,
  favoritesSyncState,
  favoritesSyncStatus,
  favoritesProgress,
  favoritesErrors,
  runFavoritesSync,
  cancelFavoritesSync
}: FavoritesAccountsSettingsProps) {
  const results = favoritesSyncStatus?.results ?? [];
  const added = results.reduce((sum, entry) => sum + entry.added, 0);
  const removed = results.reduce((sum, entry) => sum + entry.removed, 0);
  return (
    <div className="row g-0 settings-sections">
      <div className="col-12 settings-section">
        <div className="card bg-transparent text-foreground border-0 h-full settings-section-card">
          <div className="card-body">
            <p className="text-muted-foreground text-sm mb-4">
              Configure the sites and credentials used to browse Explore.
            </p>

            {favoritesAvailable ? (
            <div className="flex flex-wrap gap-2 mb-2">
              <button
                className="btn btn-outline-light btn-sm"
                type="button"
                onClick={() => void runFavoritesSync(false)}
                disabled={
                  favoritesSyncState.loading ||
                  favoritesSyncStatus?.status === 'running'
                }
              >
                Sync favorites
              </button>
              {favoritesSyncStatus?.status === 'running' ? (
                <button
                  className="btn btn-outline-danger btn-sm"
                  type="button"
                  onClick={() => void cancelFavoritesSync()}
                  disabled={favoritesSyncState.loading}
                >
                  Cancel sync
                </button>
              ) : null}
            </div>

            ) : (
              <p className="text-muted-foreground text-sm mb-4" role="status">
                Favorites sync is not available in this development build.
                You can browse posts from your configured sites in Explore.
              </p>
            )}

            {favoritesSyncState.loading ||
            favoritesSyncStatus?.status === 'running' ? (
              <div className="text-muted-foreground text-sm">
                {favoritesSyncStatus?.message ?? 'Syncing favorites…'}
              </div>
            ) : null}
            {favoritesSyncState.error ? (
              <div className="text-destructive text-sm mb-2">
                Error: {favoritesSyncState.error}
              </div>
            ) : null}
            {favoritesSyncStatus?.status === 'running' &&
            favoritesProgress !== null ? (
              <div
                className="progress bg-background border border-secondary mt-2"
                style={{ height: 8 }}
              >
                <div
                  className="progress-bar bg-info"
                  role="progressbar"
                  style={{ width: `${favoritesProgress}%` }}
                  aria-valuenow={favoritesProgress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>
            ) : null}
            {favoritesSyncStatus &&
            favoritesSyncStatus.status !== 'running' &&
            results.length ? (
              <div className="text-muted-foreground text-sm mt-1 mb-2">
                Last sync {formatDateTime(favoritesSyncStatus.updatedAt)}:{' '}
                {added} added, {removed} removed
              </div>
            ) : null}
            {favoritesErrors.length ? (
              <div className="text-destructive text-sm mt-2 mb-3">
                {favoritesErrors.slice(0, 6).map((line, index) => (
                  <div key={index}>{line}</div>
                ))}
                {favoritesErrors.length > 6 ? (
                  <details>
                    <summary className="cursor-pointer">
                      Show {favoritesErrors.length - 6} more errors
                    </summary>
                    {favoritesErrors.slice(6).map((line, index) => (
                      <div key={index}>{line}</div>
                    ))}
                  </details>
                ) : null}
              </div>
            ) : null}

            <BooruSitesPanel
              className="mb-6"
              showSuggestions
            />

            <BooruEngineSupportTable />
          </div>
        </div>
      </div>
    </div>
  );
}
