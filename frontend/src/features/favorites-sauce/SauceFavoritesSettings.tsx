import { BooruSitesPanel } from '@/BooruSitesPanel';
import type {
  FavoriteSyncStatus,
  SauceProgress,
  SauceSettings,
  SauceSource,
} from '@/api';
import type { CredentialProvider } from '@/api';

type FetchState = { loading: boolean; error: string | null };

interface FavoritesSettings {
  reverseSyncEnabled: boolean;
  autoSyncMidnight: boolean;
  autoFavEnabled: boolean;
  favoritesRootId: string | null;
}

interface SauceProgressSegments {
  matched: number;
  failed: number;
  pending: number;
}

export interface SauceFavoritesSettingsProps {
  // Sauce state
  sauceSources: SauceSource[];
  sauceSettings: SauceSettings;
  sauceProgress: SauceProgress;
  sauceState: FetchState;
  sauceProgressSegments: SauceProgressSegments;
  displaySet: Set<string>;
  targetSet: Set<string>;

  // Favorites state
  favoritesSyncState: FetchState;
  favoritesSyncStatus: FavoriteSyncStatus | null;
  favoritesSettings: FavoritesSettings;
  favoritesSettingsState: FetchState;
  favoritesProgress: number | null;
  favoritesSummary: string[];
  favoritesErrors: string[];

  // Legacy credential state (for E621 / Danbooru legacy cards)
  e621Ready: boolean;
  danbooruReady: boolean;
  saucenaoReady: boolean;
  credentialsState: FetchState;
  credentialLastProvider: CredentialProvider | null;
  credentialInputs: Record<CredentialProvider, { username: string; apiKey: string }>;
  credentialExpanded: Record<CredentialProvider, boolean>;

  // Booru dev options
  booruDevOptions: boolean;

  // Handlers — sauce
  toggleDisplaySauce: (key: string) => void;
  toggleTargetSauce: (key: string) => void;
  setAllDisplay: (value: boolean) => void;
  setAllTargets: (value: boolean) => void;

  // Handlers — favorites
  runFavoritesSync: (deleteMissing: boolean) => Promise<void>;
  updateFavoritesSettings: (updates: Partial<Omit<FavoritesSettings, 'favoritesRootId'> & { favoritesRootId?: string | null }>) => Promise<void>;

  // Handlers — legacy credentials
  logoutCredential: (provider: CredentialProvider) => Promise<void>;
  saveCredential: (provider: CredentialProvider) => Promise<void>;
  updateCredentialInput: (provider: CredentialProvider, field: 'username' | 'apiKey', value: string) => void;
  setCredentialExpanded: (updater: (prev: Record<CredentialProvider, boolean>) => Record<CredentialProvider, boolean>) => void;

  // Handlers — dev options
  setBooruDevOptionsPersistent: (next: boolean) => void;

  // Key normalization helper (canonicalizeSauceKey from App.tsx)
  canonicalizeSauceKey: (key: string) => string;
}

const formatDateTime = (value: string | null | undefined): string => {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
};

export function SauceFavoritesSettings({
  sauceSources,
  sauceProgress,
  sauceState,
  sauceProgressSegments,
  displaySet,
  targetSet,
  favoritesSyncState,
  favoritesSyncStatus,
  favoritesSettings,
  favoritesSettingsState,
  favoritesProgress,
  favoritesSummary,
  favoritesErrors,
  e621Ready,
  danbooruReady,
  saucenaoReady,
  credentialsState,
  credentialLastProvider,
  credentialInputs,
  credentialExpanded,
  booruDevOptions,
  toggleDisplaySauce,
  toggleTargetSauce,
  setAllDisplay,
  setAllTargets,
  runFavoritesSync,
  updateFavoritesSettings,
  logoutCredential,
  saveCredential,
  updateCredentialInput,
  setCredentialExpanded,
  setBooruDevOptionsPersistent,
}: SauceFavoritesSettingsProps) {
  return (
    <>
      {/* Sync favorites section */}
      <div className="col-12 settings-section">
        <div className="card bg-transparent text-foreground border-0 h-full settings-section-card">
          <div className="card-body">
            <div className="flex justify-between items-center mb-2">
              <h2 className="h5 mb-0">Sync favorites</h2>
            </div>
            <p className="text-muted-foreground text-sm mb-4">
              Connect your e621 and Danbooru accounts to double-sync favorites.
            </p>

            <BooruSitesPanel className="mb-6" devOptions={booruDevOptions} />

            <div className="flex flex-wrap gap-2 mb-2">
              <button
                className="btn btn-outline-light btn-sm"
                onClick={() => void runFavoritesSync(true)}
                disabled={favoritesSyncState.loading}
              >
                Sync favorites
              </button>
            </div>
            <div className="form-check form-switch mb-2">
              <input
                className="form-check-input"
                type="checkbox"
                id="auto-sync-toggle-top"
                checked={favoritesSettings.autoSyncMidnight}
                onChange={(event) => void updateFavoritesSettings({ autoSyncMidnight: event.target.checked })}
                disabled={favoritesSettingsState.loading}
              />
              <label className="form-check-label text-muted-foreground text-sm" htmlFor="auto-sync-toggle-top">
                Run a daily sync at midnight to keep favorites current
              </label>
            </div>
            <div className="form-check form-switch mb-2">
              <input
                className="form-check-input"
                type="checkbox"
                id="reverse-sync-toggle-top"
                checked={favoritesSettings.reverseSyncEnabled}
                onChange={(event) => void updateFavoritesSettings({ reverseSyncEnabled: event.target.checked })}
                disabled={favoritesSettingsState.loading}
              />
              <label className="form-check-label text-muted-foreground text-sm" htmlFor="reverse-sync-toggle-top">
                When you delete a file here, also remove it from favorites
              </label>
            </div>
            <div className="form-check form-switch mb-4">
              <input
                className="form-check-input"
                type="checkbox"
                id="auto-fav-toggle-top"
                checked={favoritesSettings.autoFavEnabled}
                onChange={(event) => void updateFavoritesSettings({ autoFavEnabled: event.target.checked })}
                disabled={favoritesSettingsState.loading}
              />
              <label className="form-check-label text-muted-foreground text-sm" htmlFor="auto-fav-toggle-top">
                When the sources scanner finds a match on a logged-in source, auto-favorite it there
              </label>
            </div>

            <details className="mb-4">
              <summary className="text-muted-foreground text-sm">Legacy credential cards (E621 / Danbooru)</summary>
              <div className="credential-grid mb-4">
                <div className="credential-col">
                  <div className="border border-secondary rounded p-2 credential-card">
                    <div className="flex justify-between items-center gap-2">
                      <div className="font-semibold">e621</div>
                      <div className="flex items-center gap-2">
                        {e621Ready ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-outline-light btn-sm"
                              onClick={() => void logoutCredential('E621')}
                              disabled={credentialsState.loading}
                            >
                              Log out
                            </button>
                            <span className="btn btn-success btn-sm credential-status">Logged in</span>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn-outline-light btn-sm"
                              onClick={() =>
                                setCredentialExpanded((prev) => ({ ...prev, E621: true }))
                              }
                              disabled={credentialsState.loading}
                            >
                              Log in
                            </button>
                            <span className="btn btn-danger btn-sm credential-status">Logged out</span>
                          </>
                        )}
                      </div>
                    </div>
                    {!e621Ready && credentialExpanded.E621 ? (
                      <div className="mt-2 credential-fields" id="credential-e621">
                        <label className="form-label text-sm text-muted-foreground" htmlFor="cred-e621-username">Username</label>
                        <input
                          id="cred-e621-username"
                          name="e621-username"
                          type="text"
                          className="form-control form-control-sm mb-2"
                          value={credentialInputs.E621.username}
                          onChange={(event) => updateCredentialInput('E621', 'username', event.target.value)}
                          placeholder="Enter your e621 username"
                          disabled={credentialsState.loading}
                          autoComplete="username"
                        />
                        <label className="form-label text-sm text-muted-foreground" htmlFor="cred-e621-apikey">API key</label>
                        <input
                          id="cred-e621-apikey"
                          name="e621-api-key"
                          type="password"
                          className="form-control form-control-sm"
                          value={credentialInputs.E621.apiKey}
                          onChange={(event) => updateCredentialInput('E621', 'apiKey', event.target.value)}
                          placeholder="Enter API key"
                          disabled={credentialsState.loading}
                          autoComplete="off"
                        />
                        <div className="flex items-center gap-2 mt-2">
                          <button
                            className="btn btn-outline-light btn-sm"
                            onClick={() => void saveCredential('E621')}
                            disabled={credentialsState.loading}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="credential-col">
                  <div className="border border-secondary rounded p-2 credential-card">
                    <div className="flex justify-between items-center gap-2">
                      <div className="font-semibold">Danbooru</div>
                      <div className="flex items-center gap-2">
                        {danbooruReady ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-outline-light btn-sm"
                              onClick={() => void logoutCredential('DANBOORU')}
                              disabled={credentialsState.loading}
                            >
                              Log out
                            </button>
                            <span className="btn btn-success btn-sm credential-status">Logged in</span>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn btn-outline-light btn-sm"
                              onClick={() =>
                                setCredentialExpanded((prev) => ({ ...prev, DANBOORU: true }))
                              }
                              disabled={credentialsState.loading}
                            >
                              Log in
                            </button>
                            <span className="btn btn-danger btn-sm credential-status">Logged out</span>
                          </>
                        )}
                      </div>
                    </div>
                    {!danbooruReady && credentialExpanded.DANBOORU ? (
                      <div className="mt-2 credential-fields" id="credential-danbooru">
                        <label className="form-label text-sm text-muted-foreground" htmlFor="cred-danbooru-username">Username</label>
                        <input
                          id="cred-danbooru-username"
                          name="danbooru-username"
                          type="text"
                          className="form-control form-control-sm mb-2"
                          value={credentialInputs.DANBOORU.username}
                          onChange={(event) => updateCredentialInput('DANBOORU', 'username', event.target.value)}
                          placeholder="Enter your Danbooru username"
                          disabled={credentialsState.loading}
                          autoComplete="username"
                        />
                        <label className="form-label text-sm text-muted-foreground" htmlFor="cred-danbooru-apikey">API key</label>
                        <input
                          id="cred-danbooru-apikey"
                          name="danbooru-api-key"
                          type="password"
                          className="form-control form-control-sm"
                          value={credentialInputs.DANBOORU.apiKey}
                          onChange={(event) => updateCredentialInput('DANBOORU', 'apiKey', event.target.value)}
                          placeholder="Enter API key"
                          disabled={credentialsState.loading}
                          autoComplete="off"
                        />
                        <div className="flex items-center gap-2 mt-2">
                          <button
                            className="btn btn-outline-light btn-sm"
                            onClick={() => void saveCredential('DANBOORU')}
                            disabled={credentialsState.loading}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </details>
            {credentialsState.error &&
            (credentialLastProvider === null ||
              credentialLastProvider === 'E621' ||
              credentialLastProvider === 'DANBOORU') ? (
              <div className="text-destructive text-sm mb-2">Credentials error: {credentialsState.error}</div>
            ) : null}
            {favoritesSettingsState.error ? (
              <div className="text-destructive text-sm">Settings error: {favoritesSettingsState.error}</div>
            ) : null}
            {favoritesSyncState.loading || favoritesSyncStatus?.status === 'running' ? (
              <div className="text-muted-foreground text-sm">
                {favoritesSyncStatus?.message ?? 'Syncing favorites…'}
              </div>
            ) : null}
            {favoritesSyncStatus ? (
              <div className="text-muted-foreground text-sm mt-1">
                <div>Last sync started: {formatDateTime(favoritesSyncStatus.startedAt)}</div>
                <div>Last sync updated: {formatDateTime(favoritesSyncStatus.updatedAt)}</div>
              </div>
            ) : null}
            {favoritesSyncState.error ? (
              <div className="text-destructive text-sm">Error: {favoritesSyncState.error}</div>
            ) : null}
            {favoritesSyncStatus?.status === 'running' && favoritesProgress !== null ? (
              <div className="progress bg-background border border-secondary mt-2" style={{ height: 8 }}>
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
              <div className="text-muted-foreground text-sm mt-2">
                {favoritesSyncStatus.progress.providers.map((entry) => (
                  <div key={entry.provider}>
                    {entry.provider}: {entry.stage} · {entry.processed}/{entry.total} · +{entry.added} / -
                    {entry.removed}
                  </div>
                ))}
              </div>
            ) : null}
            {favoritesSummary.length ? (
              <div className="text-muted-foreground text-sm">
                {favoritesSummary.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            ) : null}
            {favoritesErrors.length ? (
              <div className="text-destructive text-sm mt-2">
                {favoritesErrors.slice(0, 6).map((line) => (
                  <div key={line}>{line}</div>
                ))}
                {favoritesErrors.length > 6 ? (
                  <div>…and {favoritesErrors.length - 6} more errors</div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Sauces section */}
      <div className="col-12 settings-section">
        <div className="card bg-transparent text-foreground border-0 h-full settings-section-card">
          <div className="card-body">
            <div className="flex justify-between items-center mb-2">
              <h2 className="h5 mb-0">Sauces</h2>
            </div>
            <p className="text-muted-foreground text-sm mb-4">
              Pick which sources appear in the file view and which ones the scanner should look for
              automatically. Targeted sources are retried daily for up to a week or until a match is found.
            </p>
            <div className="credential-grid mb-4">
              <div className="credential-col">
                <div className="border border-secondary rounded p-2 credential-card">
                  <div className="flex justify-between items-center gap-2">
                    <div className="font-semibold">SauceNAO</div>
                    <div className="flex items-center gap-2">
                      {saucenaoReady ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-outline-light btn-sm"
                            onClick={() => void logoutCredential('SAUCENAO')}
                            disabled={credentialsState.loading}
                          >
                            Log out
                          </button>
                          <span className="btn btn-success btn-sm credential-status">Logged in</span>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn btn-outline-light btn-sm"
                            onClick={() =>
                              setCredentialExpanded((prev) => ({ ...prev, SAUCENAO: true }))
                            }
                            disabled={credentialsState.loading}
                          >
                            Log in
                          </button>
                          <span className="btn btn-danger btn-sm credential-status">Logged out</span>
                        </>
                      )}
                    </div>
                  </div>
                  {!saucenaoReady && credentialExpanded.SAUCENAO ? (
                    <div className="mt-2 credential-fields" id="credential-saucenao">
                      <label className="form-label text-sm text-muted-foreground" htmlFor="cred-saucenao-username">Username</label>
                      <input
                        id="cred-saucenao-username"
                        name="saucenao-username"
                        type="text"
                        className="form-control form-control-sm mb-2"
                        value=""
                        placeholder="Not used for SauceNAO"
                        disabled
                      />
                      <label className="form-label text-sm text-muted-foreground" htmlFor="cred-saucenao-apikey">API key</label>
                      <input
                        id="cred-saucenao-apikey"
                        name="saucenao-api-key"
                        type="password"
                        className="form-control form-control-sm"
                        value={credentialInputs.SAUCENAO.apiKey}
                        onChange={(event) => updateCredentialInput('SAUCENAO', 'apiKey', event.target.value)}
                        placeholder="Enter API key"
                        disabled={credentialsState.loading}
                      />
                      <div className="flex items-center gap-2 mt-2">
                        <button
                          className="btn btn-outline-light btn-sm"
                          onClick={() => void saveCredential('SAUCENAO')}
                          disabled={credentialsState.loading}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="credential-col">
                <div className="border border-secondary rounded p-2 credential-card">
                  <div className="flex justify-between items-center gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="font-semibold">Fluffle</div>
                      <div className="text-muted-foreground text-sm">No login required.</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="btn btn-success btn-sm credential-status">Working</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            {credentialsState.error && credentialLastProvider === 'SAUCENAO' ? (
              <div className="text-destructive text-sm mb-2">Credentials error: {credentialsState.error}</div>
            ) : null}
            <div className="sauce-progress-wrap mb-4">
              <div className="sauce-progress-bar border border-secondary bg-background" role="img" aria-label="Sauce target scan progress">
                <div
                  className="sauce-progress-segment bg-success"
                  style={{ width: `${sauceProgressSegments.matched}%` }}
                />
                <div
                  className="sauce-progress-segment bg-danger"
                  style={{ width: `${sauceProgressSegments.failed}%` }}
                />
                <div
                  className="sauce-progress-segment sauce-progress-segment-pending"
                  style={{ width: `${sauceProgressSegments.pending}%` }}
                />
              </div>
              <div className="sauce-progress-legend text-muted-foreground text-sm mt-2">
                <span className="sauce-progress-legend-item">
                  <span className="sauce-progress-dot bg-success" />
                  Target found ({sauceProgress.matched})
                </span>
                <span className="sauce-progress-legend-item">
                  <span className="sauce-progress-dot bg-danger" />
                  Failed ({sauceProgress.failed})
                </span>
                <span className="sauce-progress-legend-item">
                  <span className="sauce-progress-dot sauce-progress-dot-pending" />
                  Pending ({sauceProgress.pending})
                </span>
              </div>
              <hr className="sauce-progress-separator" />
            </div>
            {sauceState.error ? <div className="text-destructive mb-2">Error: {sauceState.error}</div> : null}
            {sauceSources.length === 0 ? (
              <p className="text-muted-foreground">No sources discovered yet.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 mb-4">
                  <button className="btn btn-outline-light btn-sm" onClick={() => setAllDisplay(true)}>
                    Show all
                  </button>
                  <button className="btn btn-outline-light btn-sm" onClick={() => setAllDisplay(false)}>
                    Show none
                  </button>
                  <button className="btn btn-outline-light btn-sm" onClick={() => setAllTargets(true)}>
                    Target all
                  </button>
                  <button className="btn btn-outline-light btn-sm" onClick={() => setAllTargets(false)}>
                    Clear targets
                  </button>
                </div>
                <div className="table-responsive">
                  <table className="table table-dark table-sm align-middle mb-0">
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th className="text-center">Show</th>
                        <th className="text-center">Target</th>
                        <th className="text-right">Hits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sauceSources.map((source) => {
                        const displayChecked = displaySet.has(source.key);
                        const targetChecked = targetSet.has(source.key);
                        return (
                          <tr key={source.key}>
                            <td>{source.label}</td>
                            <td className="text-center">
                              <input
                                type="checkbox"
                                className="form-check-input"
                                checked={displayChecked}
                                onChange={() => toggleDisplaySauce(source.key)}
                              />
                            </td>
                            <td className="text-center">
                              <input
                                type="checkbox"
                                className="form-check-input"
                                checked={targetChecked}
                                onChange={() => toggleTargetSauce(source.key)}
                              />
                            </td>
                            <td className="text-right text-muted-foreground">{source.count}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Developer options toggle */}
      <div className="col-12 settings-section">
        <div className="card bg-transparent text-foreground border-0 h-full settings-section-card">
          <div className="card-body">
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
          </div>
        </div>
      </div>
    </>
  );
}
