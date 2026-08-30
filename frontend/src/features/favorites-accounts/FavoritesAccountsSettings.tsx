import type { FavoriteSyncStatus } from '@/api';
import { BooruSitesPanel } from '@/BooruSitesPanel';
import { BooruEngineSupportTable } from '@/features/booru-sites/BooruEngineSupportTable';
import { formatDateTime } from '@/lib/format';

type FetchState = { loading: boolean; error: string | null };

export interface FavoritesAccountsSettingsProps {
  favoritesSyncState: FetchState;
  favoritesSyncStatus: FavoriteSyncStatus | null;
  favoritesProgress: number | null;
  favoritesSummary: string[];
  favoritesErrors: string[];
  runFavoritesSync: (deleteMissing: boolean) => Promise<void>;
  booruDevOptions: boolean;
  setBooruDevOptionsPersistent: (next: boolean) => void;
}

export function FavoritesAccountsSettings({
  favoritesSyncState,
  favoritesSyncStatus,
  favoritesProgress,
  favoritesSummary,
  favoritesErrors,
  runFavoritesSync,
  booruDevOptions,
  setBooruDevOptionsPersistent
}: FavoritesAccountsSettingsProps) {
  return (
    <div className="row g-0 settings-sections">
      <div className="col-12 settings-section">
        <div className="card bg-transparent text-foreground border-0 h-full settings-section-card">
          <div className="card-body">
            <p className="text-muted-foreground text-sm mb-4">
              Manage booru accounts, per-site sync behavior, and favorites sync
              status.
            </p>

            <div className="flex flex-wrap gap-2 mb-2">
              <button
                className="btn btn-outline-light btn-sm"
                onClick={() => void runFavoritesSync(true)}
                disabled={favoritesSyncState.loading}
              >
                Sync favorites
              </button>
            </div>

            {favoritesSyncState.loading ||
            favoritesSyncStatus?.status === 'running' ? (
              <div className="text-muted-foreground text-sm">
                {favoritesSyncStatus?.message ?? 'Syncing favorites…'}
              </div>
            ) : null}
            {favoritesSyncStatus ? (
              <div className="text-muted-foreground text-sm mt-1 mb-2">
                <div>
                  Last sync started:{' '}
                  {formatDateTime(favoritesSyncStatus.startedAt)}
                </div>
                <div>
                  Last sync updated:{' '}
                  {formatDateTime(favoritesSyncStatus.updatedAt)}
                </div>
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
            {favoritesSyncStatus?.progress?.providers?.length ? (
              <div className="text-muted-foreground text-sm mt-2 mb-2">
                {favoritesSyncStatus.progress.providers.map((entry) => (
                  <div key={entry.provider}>
                    {entry.provider}: {entry.stage} · {entry.processed}/
                    {entry.total} · +{entry.added} / -{entry.removed}
                  </div>
                ))}
              </div>
            ) : null}
            {favoritesSummary.length ? (
              <div className="text-muted-foreground text-sm mb-2">
                {favoritesSummary.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            ) : null}
            {favoritesErrors.length ? (
              <div className="text-destructive text-sm mt-2 mb-3">
                {favoritesErrors.slice(0, 6).map((line) => (
                  <div key={line}>{line}</div>
                ))}
                {favoritesErrors.length > 6 ? (
                  <div>…and {favoritesErrors.length - 6} more errors</div>
                ) : null}
              </div>
            ) : null}

            <BooruSitesPanel
              className="mb-6"
              devOptions={booruDevOptions}
              showSuggestions
            />

            <hr className="border-secondary mt-0 mb-4" />
            <div className="form-check form-switch">
              <input
                className="form-check-input"
                type="checkbox"
                id="booru-dev-options-toggle"
                checked={booruDevOptions}
                onChange={(e) => setBooruDevOptionsPersistent(e.target.checked)}
              />
              <label
                className="form-check-label text-muted-foreground text-sm"
                htmlFor="booru-dev-options-toggle"
              >
                Developer options
              </label>
            </div>

            <hr className="border-secondary mt-4 mb-4" />
            <BooruEngineSupportTable />
          </div>
        </div>
      </div>
    </div>
  );
}
