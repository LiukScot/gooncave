import type { CredentialProvider, SauceProgress, SauceSource } from '@/api';

type FetchState = { loading: boolean; error: string | null };

interface SauceProgressSegments {
  matched: number;
  failed: number;
  pending: number;
}

export interface SauceFavoritesSettingsProps {
  sauceSources: SauceSource[];
  sauceProgress: SauceProgress;
  sauceState: FetchState;
  sauceProgressSegments: SauceProgressSegments;
  displaySet: Set<string>;
  targetSet: Set<string>;

  saucenaoReady: boolean;
  credentialsState: FetchState;
  credentialLastProvider: CredentialProvider | null;
  credentialInputs: Record<
    CredentialProvider,
    { username: string; apiKey: string }
  >;
  credentialExpanded: Record<CredentialProvider, boolean>;

  toggleDisplaySauce: (key: string) => void;
  toggleTargetSauce: (key: string) => void;
  setAllDisplay: (value: boolean) => void;
  setAllTargets: (value: boolean) => void;

  logoutCredential: (provider: CredentialProvider) => Promise<void>;
  saveCredential: (provider: CredentialProvider) => Promise<void>;
  updateCredentialInput: (
    provider: CredentialProvider,
    field: 'username' | 'apiKey',
    value: string
  ) => void;
  setCredentialExpanded: (
    updater: (
      prev: Record<CredentialProvider, boolean>
    ) => Record<CredentialProvider, boolean>
  ) => void;
}

export function SauceFavoritesSettings({
  sauceSources,
  sauceProgress,
  sauceState,
  sauceProgressSegments,
  displaySet,
  targetSet,
  saucenaoReady,
  credentialsState,
  credentialLastProvider,
  credentialInputs,
  credentialExpanded,
  toggleDisplaySauce,
  toggleTargetSauce,
  setAllDisplay,
  setAllTargets,
  logoutCredential,
  saveCredential,
  updateCredentialInput,
  setCredentialExpanded
}: SauceFavoritesSettingsProps) {
  return (
    <>
      <div className="col-12 settings-section settings-section-flat text-foreground">
        <p className="text-muted-foreground text-sm mb-4">
          Pick which sources appear in the file view and which ones the scanner
          should look for automatically. Targeted sources are retried daily for
          up to a week or until a match is found.
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
                      <span className="btn btn-success btn-sm credential-status">
                        Logged in
                      </span>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn-outline-light btn-sm"
                        onClick={() =>
                          setCredentialExpanded((prev) => ({
                            ...prev,
                            SAUCENAO: true
                          }))
                        }
                        disabled={credentialsState.loading}
                      >
                        Log in
                      </button>
                      <span className="btn btn-danger btn-sm credential-status">
                        Logged out
                      </span>
                    </>
                  )}
                </div>
              </div>
              {!saucenaoReady && credentialExpanded.SAUCENAO ? (
                <div
                  className="mt-2 credential-fields"
                  id="credential-saucenao"
                >
                  <label
                    className="form-label text-sm text-muted-foreground"
                    htmlFor="cred-saucenao-username"
                  >
                    Username
                  </label>
                  <input
                    id="cred-saucenao-username"
                    name="saucenao-username"
                    type="text"
                    className="form-control form-control-sm mb-2"
                    value=""
                    placeholder="Not used for SauceNAO"
                    disabled
                  />
                  <label
                    className="form-label text-sm text-muted-foreground"
                    htmlFor="cred-saucenao-apikey"
                  >
                    API key
                  </label>
                  <input
                    id="cred-saucenao-apikey"
                    name="saucenao-api-key"
                    type="password"
                    className="form-control form-control-sm"
                    value={credentialInputs.SAUCENAO.apiKey}
                    onChange={(event) =>
                      updateCredentialInput(
                        'SAUCENAO',
                        'apiKey',
                        event.target.value
                      )
                    }
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
                  <div className="text-muted-foreground text-sm">
                    No login required.
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="btn btn-success btn-sm credential-status">
                    Working
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
        {credentialsState.error && credentialLastProvider === 'SAUCENAO' ? (
          <div className="text-destructive text-sm mb-2">
            Credentials error: {credentialsState.error}
          </div>
        ) : null}
        <div className="sauce-progress-wrap mb-4">
          <div
            className="sauce-progress-bar border border-secondary bg-background"
            role="img"
            aria-label="Sauce target scan progress"
          >
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
        {sauceState.error ? (
          <div className="text-destructive mb-2">Error: {sauceState.error}</div>
        ) : null}
        {sauceSources.length === 0 ? (
          <p className="text-muted-foreground">No sources discovered yet.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 mb-4">
              <button
                className="btn btn-outline-light btn-sm"
                onClick={() => setAllDisplay(true)}
              >
                Show all
              </button>
              <button
                className="btn btn-outline-light btn-sm"
                onClick={() => setAllDisplay(false)}
              >
                Show none
              </button>
              <button
                className="btn btn-outline-light btn-sm"
                onClick={() => setAllTargets(true)}
              >
                Target all
              </button>
              <button
                className="btn btn-outline-light btn-sm"
                onClick={() => setAllTargets(false)}
              >
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
                        <td className="text-right text-muted-foreground">
                          {source.count}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
