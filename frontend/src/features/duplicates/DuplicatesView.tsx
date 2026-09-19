import type {
  DuplicateFile,
  DuplicateScanStats,
  DuplicateScanStatus,
  DuplicateSettings
} from '@/api';
import { API_BASE } from '@/api';
import { basenameFromPath, fileTypeFromPath, formatSizeMb } from '@/lib/format';

// ── types ────────────────────────────────────────────────────────────────────

type FetchState = {
  loading: boolean;
  error: string | null;
};

export type DuplicatePair = {
  key: string;
  groupKey: string;
  left: DuplicateFile;
  right: DuplicateFile;
  suggestedKeepId: string | null;
  reason: string;
};

export interface DuplicatesViewProps {
  // settings
  duplicateSettings: DuplicateSettings;
  duplicateProviders: { key: string; label: string }[];
  duplicateSettingsState: FetchState;
  updateDuplicateSettings: (updates: Partial<DuplicateSettings>) => void;

  // scan state
  duplicateState: FetchState;
  duplicateScanStatus: DuplicateScanStatus | null;
  loadDuplicates: () => void;

  // pairs (already resolved from groups by parent)
  duplicatePairs: DuplicatePair[];

  // stats (shown after a scan)
  duplicateStats: DuplicateScanStats | null;

  // actions on pairs
  duplicateAction: { loadingId: string | null; error: string | null };
  resolveDuplicateChoice: (keep: DuplicateFile, discard: DuplicateFile) => void;
  resolveDuplicateKeepBoth: (pairKey: string) => void;
}

// ── sub-component ────────────────────────────────────────────────────────────

function DuplicateCard({
  file,
  suggested,
  reason
}: {
  file: DuplicateFile;
  suggested: boolean;
  reason: string;
}) {
  return (
    <div className={`duplicate-card${suggested ? ' is-suggested' : ''}`}>
      <div className="duplicate-thumb">
        {file.thumbUrl ? (
          <img
            src={`${API_BASE}${file.thumbUrl}`}
            alt={file.path}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="text-muted-foreground text-sm">
            {file.mediaType.toLowerCase()}
          </div>
        )}
      </div>
      <div className="flex justify-between items-center">
        <div className="font-semibold truncate">
          {basenameFromPath(file.path)}
        </div>
        {suggested ? (
          <span className="badge bg-success duplicate-suggested-badge">
            Suggested
          </span>
        ) : null}
      </div>
      <div className="text-muted-foreground text-sm">
        {fileTypeFromPath(file.path, file.mediaType)} ·{' '}
        {formatSizeMb(file.sizeBytes)}
        {file.width && file.height ? ` · ${file.width}×${file.height}` : ''}
      </div>
      {file.favoriteProviders?.length ? (
        <div className="text-muted-foreground text-sm">
          favorites:{' '}
          {file.favoriteProviders
            .map((provider) => provider.toLowerCase())
            .join(', ')}
        </div>
      ) : null}
      {suggested ? (
        <div className="text-success text-sm duplicate-suggested-reason">
          {reason}
        </div>
      ) : null}
      <div className="text-muted-foreground text-sm duplicate-path">
        {file.path}
      </div>
    </div>
  );
}

// ── main component ───────────────────────────────────────────────────────────

export function DuplicatesView({
  duplicateSettings,
  duplicateProviders,
  duplicateSettingsState,
  updateDuplicateSettings,
  duplicateState,
  duplicateScanStatus,
  loadDuplicates,
  duplicatePairs,
  duplicateStats,
  duplicateAction,
  resolveDuplicateChoice,
  resolveDuplicateKeepBoth
}: DuplicatesViewProps) {
  return (
    <div className="col-12">
      <div className="card bg-transparent text-foreground border-0 h-full content-shell-card">
        <div className="card-body">
          <section className="settings-section" aria-label="Duplicate scan">
            <p className="text-muted-foreground text-sm mb-3">
              Find visually matching images and videos in your library.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={loadDuplicates}
                disabled={duplicateState.loading}
              >
                {duplicateState.loading ? 'Scanning…' : 'Run scan'}
              </button>
              <div className="form-check form-switch mb-0">
                <input
                  className="form-check-input"
                  type="checkbox"
                  id="duplicate-auto-resolve-toggle"
                  checked={duplicateSettings.autoResolve}
                  onChange={(event) =>
                    updateDuplicateSettings({
                      autoResolve: event.target.checked
                    })
                  }
                  disabled={duplicateSettingsState.loading}
                />
                <label
                  className="form-check-label text-muted-foreground text-sm"
                  htmlFor="duplicate-auto-resolve-toggle"
                >
                  Auto-resolve after scan
                </label>
              </div>
            </div>
            {duplicateState.error ? (
              <div className="text-destructive mb-2">
                Error: {duplicateState.error}
              </div>
            ) : null}
            {duplicateState.loading && duplicateScanStatus?.progress ? (
              <div className="mt-3">
                <div className="flex justify-between text-muted-foreground text-sm mb-1">
                  <span>{duplicateScanStatus.progress.message}</span>
                  <span>
                    {duplicateScanStatus.progress.total > 0
                      ? `${Math.min(
                          100,
                          Math.round(
                            (duplicateScanStatus.progress.processed /
                              duplicateScanStatus.progress.total) *
                              100
                          )
                        )}%`
                      : 'working'}
                  </span>
                </div>
                <div
                  className="progress bg-secondary bg-opacity-25"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="progress-bar progress-bar-striped progress-bar-animated"
                    style={{
                      width:
                        duplicateScanStatus.progress.total > 0
                          ? `${Math.min(
                              100,
                              Math.round(
                                (duplicateScanStatus.progress.processed /
                                  duplicateScanStatus.progress.total) *
                                  100
                              )
                            )}%`
                          : '100%'
                    }}
                  />
                </div>
              </div>
            ) : null}
          </section>
          <section
            className="border-top border-secondary mt-4 pt-3"
            aria-label="Preferred sources"
          >
            <div className="flex flex-wrap items-baseline gap-2 mb-2">
              <h2 className="h6 mb-0">Preferred sources</h2>
              <p className="text-muted-foreground text-sm mb-0">
                Ranks synced favorites before comparing quality.
              </p>
            </div>
            {duplicateProviders.length ? (
              <div className="flex flex-col gap-1">
                {duplicateProviders.map((provider, index) => (
                  <div
                    key={provider.key}
                    className="border border-secondary rounded py-2 px-2 flex items-center gap-2"
                  >
                    <span className="text-muted-foreground text-sm w-5 text-center">
                      {index + 1}
                    </span>
                    <span className="grow">{provider.label}</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-light"
                      aria-label={`Move ${provider.label} up`}
                      disabled={index === 0 || duplicateSettingsState.loading}
                      onClick={() => {
                        const reordered = [
                          ...duplicateSettings.providerPriority
                        ];
                        [reordered[index - 1], reordered[index]] = [
                          reordered[index],
                          reordered[index - 1]
                        ];
                        updateDuplicateSettings({
                          providerPriority: reordered
                        });
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-light"
                      aria-label={`Move ${provider.label} down`}
                      disabled={
                        index === duplicateProviders.length - 1 ||
                        duplicateSettingsState.loading
                      }
                      onClick={() => {
                        const reordered = [
                          ...duplicateSettings.providerPriority
                        ];
                        [reordered[index], reordered[index + 1]] = [
                          reordered[index + 1],
                          reordered[index]
                        ];
                        updateDuplicateSettings({
                          providerPriority: reordered
                        });
                      }}
                    >
                      ↓
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm mb-0">
                Configure a site in Accounts to rank it here.
              </p>
            )}
            {duplicateSettingsState.error ? (
              <div className="text-destructive mt-2">
                Settings error: {duplicateSettingsState.error}
              </div>
            ) : null}
          </section>
          {duplicateAction.error ||
          duplicateState.loading ||
          duplicateStats ||
          duplicatePairs.length > 0 ? (
            <section className="mt-4" aria-label="Duplicate results">
              {duplicateAction.error ? (
                <div className="text-destructive mb-2">
                  Delete error: {duplicateAction.error}
                </div>
              ) : null}
              {duplicateStats && duplicatePairs.length > 0 ? (
                <div className="text-muted-foreground text-sm mt-3 mb-2">
                  {duplicatePairs.length} duplicate pairs
                </div>
              ) : null}
              {duplicatePairs.length === 0 &&
              (duplicateState.loading || duplicateStats) ? (
                <p className="text-muted-foreground text-sm mt-2 mb-0">
                  {duplicateState.loading
                    ? 'Scanning duplicates…'
                    : 'No duplicates found.'}
                </p>
              ) : duplicatePairs.length > 0 ? (
                duplicatePairs.map((pair, index) => {
                  const leftSuggested =
                    !!pair.suggestedKeepId &&
                    pair.suggestedKeepId === pair.left.id;
                  const rightSuggested =
                    !!pair.suggestedKeepId &&
                    pair.suggestedKeepId === pair.right.id;
                  const suggestedSide = pair.suggestedKeepId
                    ? leftSuggested
                      ? 'left'
                      : 'right'
                    : 'both';
                  const actionBusy =
                    duplicateAction.loadingId === pair.left.id ||
                    duplicateAction.loadingId === pair.right.id;
                  return (
                    <div
                      key={pair.key}
                      className="duplicate-pair border border-secondary rounded p-4 mb-4"
                    >
                      <div className="flex justify-between items-center mb-2">
                        <div className="text-muted-foreground text-sm">
                          Pair {index + 1}
                        </div>
                        <div className="text-muted-foreground text-sm">
                          Suggested: keep {suggestedSide} ({pair.reason})
                        </div>
                      </div>
                      <div className="row g-3">
                        <div className="col-md-6">
                          <DuplicateCard
                            file={pair.left}
                            suggested={leftSuggested}
                            reason={pair.reason}
                          />
                        </div>
                        <div className="col-md-6">
                          <DuplicateCard
                            file={pair.right}
                            suggested={rightSuggested}
                            reason={pair.reason}
                          />
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 mt-4">
                        <button
                          className="btn btn-success btn-sm"
                          onClick={() =>
                            resolveDuplicateChoice(pair.left, pair.right)
                          }
                          disabled={actionBusy}
                        >
                          Keep left
                        </button>
                        <button
                          className="btn btn-success btn-sm"
                          onClick={() =>
                            resolveDuplicateChoice(pair.right, pair.left)
                          }
                          disabled={actionBusy}
                        >
                          Keep right
                        </button>
                        <button
                          className="btn btn-outline-light btn-sm"
                          onClick={() => resolveDuplicateKeepBoth(pair.key)}
                          disabled={actionBusy}
                        >
                          Keep both
                        </button>
                      </div>
                    </div>
                  );
                })
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
