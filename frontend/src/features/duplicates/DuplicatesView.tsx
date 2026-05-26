import type React from 'react';
import type {
  DuplicateFile,
  DuplicateScanOptions,
  DuplicateScanStats,
  DuplicateScanStatus,
  DuplicateSettings,
} from '@/api';
import { API_BASE } from '@/api';

// ── local helpers (tiny formatters, no need to import) ──────────────────────

const basenameFromPath = (value: string): string => {
  if (!value) return '';
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
};

const fileTypeFromPath = (value: string, mediaType: DuplicateFile['mediaType']): string => {
  const name = basenameFromPath(value);
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex > 0 && dotIndex < name.length - 1) {
    return name.slice(dotIndex + 1).toUpperCase();
  }
  return mediaType === 'VIDEO' ? 'VIDEO' : 'IMAGE';
};

const formatSizeMb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const toNumberOr = (value: string, fallback: number): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

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
  duplicateSettingsState: FetchState;
  updateDuplicateSettings: (updates: Partial<DuplicateSettings>) => void;

  // scan options (controlled by parent)
  duplicateOptions: DuplicateScanOptions;
  setDuplicateOptions: React.Dispatch<React.SetStateAction<DuplicateScanOptions>>;

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
  reason,
}: {
  file: DuplicateFile;
  suggested: boolean;
  reason: string;
}) {
  return (
    <div className={`duplicate-card${suggested ? ' is-suggested' : ''}`}>
      <div className="duplicate-thumb">
        {file.thumbUrl ? (
          <img src={`${API_BASE}${file.thumbUrl}`} alt={file.path} loading="lazy" decoding="async" />
        ) : (
          <div className="text-muted-foreground text-sm">{file.mediaType.toLowerCase()}</div>
        )}
      </div>
      <div className="flex justify-between items-center">
        <div className="font-semibold truncate">{basenameFromPath(file.path)}</div>
        {suggested ? <span className="badge bg-success duplicate-suggested-badge">Suggested</span> : null}
      </div>
      <div className="text-muted-foreground text-sm">
        {fileTypeFromPath(file.path, file.mediaType)} · {formatSizeMb(file.sizeBytes)}
        {file.width && file.height ? ` · ${file.width}×${file.height}` : ''}
      </div>
      {file.favoriteProviders?.length ? (
        <div className="text-muted-foreground text-sm">
          favorites: {file.favoriteProviders.map((provider) => provider.toLowerCase()).join(', ')}
        </div>
      ) : null}
      {suggested ? <div className="text-success text-sm duplicate-suggested-reason">{reason}</div> : null}
      <div className="text-muted-foreground text-sm duplicate-path">{file.path}</div>
    </div>
  );
}

// ── main component ───────────────────────────────────────────────────────────

export function DuplicatesView({
  duplicateSettings,
  duplicateSettingsState,
  updateDuplicateSettings,
  duplicateOptions,
  setDuplicateOptions,
  duplicateState,
  duplicateScanStatus,
  loadDuplicates,
  duplicatePairs,
  duplicateStats,
  duplicateAction,
  resolveDuplicateChoice,
  resolveDuplicateKeepBoth,
}: DuplicatesViewProps) {
  return (
    <div className="col-12">
      <div className="card bg-transparent text-foreground border-0 h-full content-shell-card">
        <div className="card-body">
          <div className="flex justify-between items-center mb-4">
            {duplicateStats ? (
              <span className="text-muted-foreground text-sm">{duplicatePairs.length} groups</span>
            ) : null}
          </div>
          <p className="text-muted-foreground text-sm mb-4">
            Groups files by media type and dimensions, then compares downscaled pixels (videos use sampled frames).
          </p>
          <div className="form-check form-switch mb-4">
            <input
              className="form-check-input"
              type="checkbox"
              id="duplicate-auto-resolve-toggle"
              checked={duplicateSettings.autoResolve}
              onChange={(event) => updateDuplicateSettings({ autoResolve: event.target.checked })}
              disabled={duplicateSettingsState.loading}
            />
            <label
              className="form-check-label text-muted-foreground text-sm"
              htmlFor="duplicate-auto-resolve-toggle"
            >
              Auto-resolve duplicates (prefer synced favorites, then quality)
            </label>
          </div>
          {duplicateSettingsState.error ? (
            <div className="text-destructive mb-2">Settings error: {duplicateSettingsState.error}</div>
          ) : null}
          <div className="flex flex-wrap gap-4 items-end mb-4">
            <div>
              <div className="text-muted-foreground text-sm mb-1">Media</div>
              <select
                className="form-select form-select-sm bg-background text-foreground border-secondary"
                value={duplicateOptions.mediaType ?? 'ALL'}
                onChange={(event) =>
                  setDuplicateOptions((prev) => ({
                    ...prev,
                    mediaType: event.target.value as DuplicateScanOptions['mediaType'],
                  }))
                }
              >
                <option value="ALL">All</option>
                <option value="IMAGE">Images</option>
                <option value="VIDEO">Videos</option>
              </select>
            </div>
            <button
              className="btn btn-outline-light btn-sm"
              onClick={() => loadDuplicates()}
              disabled={duplicateState.loading}
            >
              {duplicateState.loading ? 'Scanning…' : 'Run scan'}
            </button>
          </div>
          <details className="mb-4">
            <summary className="text-muted-foreground text-sm">Advanced</summary>
            <div className="flex flex-wrap gap-4 items-end mt-2">
              <div>
                <label
                  className="text-muted-foreground text-sm mb-1 block"
                  htmlFor="duplicate-pixel-threshold"
                >
                  Pixel threshold
                </label>
                <input
                  id="duplicate-pixel-threshold"
                  name="pixelThreshold"
                  className="form-control form-control-sm bg-background text-foreground border-secondary"
                  type="number"
                  step="0.005"
                  min={0}
                  max={0.2}
                  value={duplicateOptions.pixelThreshold ?? 0.005}
                  onChange={(event) =>
                    setDuplicateOptions((prev) => ({
                      ...prev,
                      pixelThreshold: clamp(
                        toNumberOr(event.target.value, prev.pixelThreshold ?? 0.005),
                        0,
                        0.2
                      ),
                    }))
                  }
                />
              </div>
              <div>
                <label
                  className="text-muted-foreground text-sm mb-1 block"
                  htmlFor="duplicate-sample-size"
                >
                  Sample size
                </label>
                <input
                  id="duplicate-sample-size"
                  name="sampleSize"
                  className="form-control form-control-sm bg-background text-foreground border-secondary"
                  type="number"
                  step="8"
                  min={8}
                  max={256}
                  value={duplicateOptions.sampleSize ?? 96}
                  onChange={(event) =>
                    setDuplicateOptions((prev) => ({
                      ...prev,
                      sampleSize: clamp(
                        Number.parseInt(event.target.value, 10) || (prev.sampleSize ?? 96),
                        8,
                        256
                      ),
                    }))
                  }
                />
              </div>
              <div>
                <label
                  className="text-muted-foreground text-sm mb-1 block"
                  htmlFor="duplicate-video-frames"
                >
                  Video frames
                </label>
                <input
                  id="duplicate-video-frames"
                  name="videoFrames"
                  className="form-control form-control-sm bg-background text-foreground border-secondary"
                  type="number"
                  step="1"
                  min={1}
                  max={8}
                  value={duplicateOptions.videoFrames ?? 3}
                  onChange={(event) =>
                    setDuplicateOptions((prev) => ({
                      ...prev,
                      videoFrames: clamp(
                        Number.parseInt(event.target.value, 10) || (prev.videoFrames ?? 3),
                        1,
                        8
                      ),
                    }))
                  }
                />
              </div>
              <div>
                <label
                  className="text-muted-foreground text-sm mb-1 block"
                  htmlFor="duplicate-max-comparisons"
                >
                  Max comparisons
                </label>
                <input
                  id="duplicate-max-comparisons"
                  name="maxComparisons"
                  className="form-control form-control-sm bg-background text-foreground border-secondary"
                  type="number"
                  step="100"
                  min={1}
                  max={100000}
                  value={duplicateOptions.maxComparisons ?? 2000}
                  onChange={(event) =>
                    setDuplicateOptions((prev) => ({
                      ...prev,
                      maxComparisons: clamp(
                        Number.parseInt(event.target.value, 10) || (prev.maxComparisons ?? 2000),
                        1,
                        100000
                      ),
                    }))
                  }
                />
              </div>
            </div>
          </details>
          {duplicateState.error ? (
            <div className="text-destructive mb-2">Error: {duplicateState.error}</div>
          ) : null}
          {duplicateState.loading && duplicateScanStatus?.progress ? (
            <div className="mb-4">
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
                        : '100%',
                  }}
                />
              </div>
              <div className="text-muted-foreground text-sm mt-1">
                Phase: {duplicateScanStatus.progress.phase} · Processed{' '}
                {duplicateScanStatus.progress.processed}/{duplicateScanStatus.progress.total} ·
                Comparisons {duplicateScanStatus.progress.comparisons} · Groups{' '}
                {duplicateScanStatus.progress.groups} · Skipped{' '}
                {duplicateScanStatus.progress.skippedNoSignature}
              </div>
            </div>
          ) : null}
          {duplicateAction.error ? (
            <div className="text-destructive mb-2">Delete error: {duplicateAction.error}</div>
          ) : null}
          {duplicateStats ? (
            <div className="text-muted-foreground text-sm mb-4">
              Eligible: {duplicateStats.eligibleFiles}/{duplicateStats.totalFiles} · Compared:{' '}
              {duplicateStats.comparedFiles} · Comparisons: {duplicateStats.comparisons} · Skipped:{' '}
              {duplicateStats.skippedNoSignature}
            </div>
          ) : null}
          {duplicatePairs.length === 0 ? (
            <p className="text-muted-foreground">
              {duplicateState.loading
                ? 'Scanning duplicates…'
                : duplicateStats
                  ? 'No duplicates found.'
                  : 'Run a scan to check for duplicates.'}
            </p>
          ) : (
            duplicatePairs.map((pair, index) => {
              const leftSuggested = !!pair.suggestedKeepId && pair.suggestedKeepId === pair.left.id;
              const rightSuggested =
                !!pair.suggestedKeepId && pair.suggestedKeepId === pair.right.id;
              const suggestedSide = pair.suggestedKeepId
                ? leftSuggested
                  ? 'left'
                  : 'right'
                : 'both';
              const actionBusy =
                duplicateAction.loadingId === pair.left.id ||
                duplicateAction.loadingId === pair.right.id;
              return (
                <div key={pair.key} className="duplicate-pair border border-secondary rounded p-4 mb-4">
                  <div className="flex justify-between items-center mb-2">
                    <div className="text-muted-foreground text-sm">Pair {index + 1}</div>
                    <div className="text-muted-foreground text-sm">
                      Suggested: keep {suggestedSide} ({pair.reason})
                    </div>
                  </div>
                  <div className="row g-3">
                    <div className="col-md-6">
                      <DuplicateCard file={pair.left} suggested={leftSuggested} reason={pair.reason} />
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
                      onClick={() => resolveDuplicateChoice(pair.left, pair.right)}
                      disabled={actionBusy}
                    >
                      Keep left
                    </button>
                    <button
                      className="btn btn-success btn-sm"
                      onClick={() => resolveDuplicateChoice(pair.right, pair.left)}
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
          )}
        </div>
      </div>
    </div>
  );
}
