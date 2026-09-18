import type { CredentialProvider, SourceProgress, SourceEntry } from '@/api';

type FetchState = { loading: boolean; error: string | null };

interface SourceProgressSegments {
  matched: number;
  failed: number;
  pending: number;
}

export interface SourceFavoritesSettingsProps {
  sources: SourceEntry[];
  sourceProgress: SourceProgress;
  sourceState: FetchState;
  sourceProgressSegments: SourceProgressSegments;
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

  toggleDisplaySource: (key: string) => void;
  toggleTargetSource: (key: string) => void;
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

export function SourceFavoritesSettings({
  sources,
  sourceProgress,
  sourceState,
  sourceProgressSegments,
  displaySet,
  targetSet,
  saucenaoReady,
  credentialsState,
  credentialLastProvider,
  credentialInputs,
  credentialExpanded,
  toggleDisplaySource,
  toggleTargetSource,
  setAllDisplay,
  setAllTargets,
  logoutCredential,
  saveCredential,
  updateCredentialInput,
  setCredentialExpanded
}: SourceFavoritesSettingsProps) {
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
        <div className="source-progress-wrap mb-4">
          <div
            className="source-progress-bar border border-secondary bg-background"
            role="img"
            aria-label="Source target scan progress"
          >
            <div
              className="source-progress-segment bg-success"
              style={{ width: `${sourceProgressSegments.matched}%` }}
            />
            <div
              className="source-progress-segment bg-danger"
              style={{ width: `${sourceProgressSegments.failed}%` }}
            />
            <div
              className="source-progress-segment source-progress-segment-pending"
              style={{ width: `${sourceProgressSegments.pending}%` }}
            />
          </div>
          <div className="source-progress-legend text-muted-foreground text-sm mt-2">
            <span className="source-progress-legend-item">
              <span className="source-progress-dot bg-success" />
              Target found ({sourceProgress.matched})
            </span>
            <span className="source-progress-legend-item">
              <span className="source-progress-dot bg-danger" />
              Failed ({sourceProgress.failed})
            </span>
            <span className="source-progress-legend-item">
              <span className="source-progress-dot source-progress-dot-pending" />
              Pending ({sourceProgress.pending})
            </span>
          </div>
          <hr className="source-progress-separator" />
        </div>
        {sourceState.error ? (
          <div className="text-destructive mb-2">Error: {sourceState.error}</div>
        ) : null}
        {sources.length === 0 ? (
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
                  {sources.map((source) => {
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
                            onChange={() => toggleDisplaySource(source.key)}
                          />
                        </td>
                        <td className="text-center">
                          <input
                            type="checkbox"
                            className="form-check-input"
                            checked={targetChecked}
                            onChange={() => toggleTargetSource(source.key)}
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
