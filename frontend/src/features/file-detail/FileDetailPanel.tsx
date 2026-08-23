import React from 'react';

import { FileDetailPreview } from './FileDetailPreview';
import { VoteControl } from './VoteControl';

import { API_BASE, type FileItem } from '@/api';
import { formatDateTime, formatDuration, formatSizeMb } from '@/lib/format';

export type FetchState = {
  loading: boolean;
  error: string | null;
};

export type TagEntry = {
  tag: string;
  category: string;
  sources: ReadonlySet<string>;
  score: number | null;
  hasManual: boolean;
};

export type TagGroup = {
  category: string;
  tags: readonly TagEntry[];
};

export type ProviderHighlight = {
  id: string;
  provider: string;
  sourceUrl: string;
  sourceName: string;
  score: number | null;
  distance: number | null;
};

export type ProviderMeta = {
  hasRuns: boolean;
  missingProviders: readonly string[];
  latestRunAt: string | null;
  nextAutoScanAt: number | null;
  activeRun: boolean;
  targetHit: boolean;
  expired: boolean;
};

export type Props = {
  // Core file
  selectedFile: FileItem;
  selectedFileName: string;
  selectedFileType: string;
  voteScore: number;
  /** Time left on the 24h cooldown, or null when a vote is allowed now. */
  voteCooldownText: string | null;
  voteSystemEnabled: boolean;
  /** Direction of a vote still inside its undo window, else null. */
  pendingVote: 1 | -1 | null;

  // Media
  mediaFullscreen: boolean;
  onToggleFullscreen: () => void;

  // Navigation
  hasPrev: boolean;
  hasNext: boolean;
  navPeek: boolean;
  prevLoadedFile: FileItem | null;
  nextLoadedFile: FileItem | null;

  // Swipe
  detailSwipeFrameRef: React.Ref<HTMLDivElement>;
  detailSwipeOffset: number;
  detailSwipeTransition: boolean;
  onDetailTouchStart: React.TouchEventHandler<HTMLDivElement>;
  // `touchmove` is bound natively by the controller (React's root listener is
  // passive, so preventDefault there is a no-op).
  onDetailTouchEnd: React.TouchEventHandler<HTMLDivElement>;

  // Action states
  shareState: FetchState;
  voteState: FetchState;
  deleteState: FetchState;
  tagState: FetchState;
  providerState: FetchState;
  matchRemoveState: FetchState;

  // Tags
  tagGroups: readonly TagGroup[];
  tagSourceSummary: string;
  manualTagInput: string;
  manualTagCategory: string;
  onManualTagInputChange: (value: string) => void;
  onManualTagCategoryChange: (value: string) => void;
  onAddManualTag: () => void;
  onRemoveManualTag: (tag: string, category: string) => void;
  onRefreshTags: () => void;

  // Provider / sauce
  providerHighlights: readonly ProviderHighlight[];
  providerMeta: ProviderMeta | null;
  nextAutoScanText: string;
  displayFilterActive: boolean;
  onRunAllProviders: () => void;
  onRemoveTopMatch: (sourceUrl: string) => void;

  // File actions
  shareSupported: boolean;
  onDownloadFile: () => void;
  onVote: (value: 1 | -1) => void;
  onUndoVote: () => void;
  onDeleteFile: (id: string) => void;
  onGoRelative: (delta: number) => void;

  // Render helper for the active media (image/video). FileDetailPreview is
  // imported directly so the parent doesn't have to pass a render callback.
  renderFileMedia: (file: FileItem) => React.ReactNode;
};

export function FileDetailPanel(props: Props): React.ReactElement {
  const {
    selectedFile,
    selectedFileName,
    selectedFileType,
    voteScore,
    voteCooldownText,
    voteSystemEnabled,
    pendingVote,
    mediaFullscreen,
    onToggleFullscreen,
    hasPrev,
    hasNext,
    navPeek,
    prevLoadedFile,
    nextLoadedFile,
    detailSwipeFrameRef,
    detailSwipeOffset,
    detailSwipeTransition,
    onDetailTouchStart,
    onDetailTouchEnd,
    shareState,
    voteState,
    deleteState,
    tagState,
    providerState,
    matchRemoveState,
    tagGroups,
    tagSourceSummary,
    manualTagInput,
    manualTagCategory,
    onManualTagInputChange,
    onManualTagCategoryChange,
    onAddManualTag,
    onRemoveManualTag,
    onRefreshTags,
    providerHighlights,
    providerMeta,
    nextAutoScanText,
    displayFilterActive,
    onRunAllProviders,
    onRemoveTopMatch,
    shareSupported,
    onDownloadFile,
    onVote,
    onUndoVote,
    onDeleteFile,
    onGoRelative,
    renderFileMedia
  } = props;

  const fullscreenToggle = (
    <button
      className="file-detail-fullscreen-btn"
      onClick={onToggleFullscreen}
      aria-label={mediaFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
      title={mediaFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
    >
      <svg
        className="file-detail-fullscreen-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {mediaFullscreen ? (
          <>
            <path d="M8 3v3a2 2 0 0 1-2 2H3" />
            <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
            <path d="M3 16h3a2 2 0 0 1 2 2v3" />
            <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
          </>
        ) : (
          <>
            <path d="M8 3H5a2 2 0 0 0-2 2v3" />
            <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
            <path d="M3 16v3a2 2 0 0 0 2 2h3" />
            <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
          </>
        )}
      </svg>
    </button>
  );

  return (
    <div
      ref={detailSwipeFrameRef}
      className={`file-detail-frame${mediaFullscreen ? ' is-fullscreen' : ''}${
        selectedFile.mediaType === 'VIDEO' ? ' is-video' : ''
      }`}
      onTouchStart={onDetailTouchStart}
      onTouchEnd={onDetailTouchEnd}
      onTouchCancel={onDetailTouchEnd}
    >
      {pendingVote ? (
        <div className="file-detail-vote-undo" role="status">
          <span>Voted {pendingVote > 0 ? 'up' : 'down'}</span>
          <button
            type="button"
            className="btn btn-link btn-sm p-0"
            onClick={onUndoVote}
          >
            Undo
          </button>
        </div>
      ) : null}
      <div
        className={`file-detail-track${detailSwipeTransition ? ' is-transitioning' : ''}`}
        style={{
          transform: `translate3d(calc(-100% + ${detailSwipeOffset}px), 0, 0)`
        }}
      >
        <FileDetailPreview
          file={prevLoadedFile}
          direction="prev"
          voteSystemEnabled={voteSystemEnabled}
        />
        <div
          className={`file-detail-panel file-detail-panel-current file-detail-layer text-foreground${selectedFile.mediaType === 'VIDEO' ? ' is-video' : ''}`}
        >
          <div
            className={`file-detail-media-wrap${mediaFullscreen ? ' is-fullscreen' : ''}`}
            style={
              {
                // Stand-in while the original decodes; the preview panels
                // already put this thumbnail in cache.
                '--file-detail-poster': selectedFile.thumbUrl
                  ? `url("${encodeURI(`${API_BASE}${selectedFile.thumbUrl}`)}")`
                  : 'none',
                // Reserve the box in the file's real shape. A fixed
                // min-height reserves the wrong shape, so the placeholder is
                // letterboxed differently from the original and the picture
                // visibly resizes once it loads.
                '--file-detail-aspect':
                  selectedFile.width && selectedFile.height
                    ? `${selectedFile.width} / ${selectedFile.height}`
                    : '4 / 3'
              } as React.CSSProperties
            }
            onClick={(e) => {
              if (mediaFullscreen && e.target === e.currentTarget)
                onToggleFullscreen();
            }}
          >
            <button
              className={`file-detail-nav file-detail-nav-left${navPeek ? ' file-detail-nav-peek' : ''}`}
              onClick={() => onGoRelative(-1)}
              disabled={!hasPrev}
              aria-label="Previous"
            >
              ‹
            </button>
            <button
              className={`file-detail-nav file-detail-nav-right${navPeek ? ' file-detail-nav-peek' : ''}`}
              onClick={() => onGoRelative(1)}
              disabled={!hasNext}
              aria-label="Next"
            >
              ›
            </button>
            {renderFileMedia(selectedFile)}
            {mediaFullscreen ? null : fullscreenToggle}
          </div>
          <div className="container file-detail-body">
            <div className="file-detail-section mb-4">
              <div className="file-detail-section-head">
                <div className="uppercase font-semibold file-detail-section-title">
                  File info
                </div>
                <div className="file-detail-section-actions">
                  <button
                    className="btn btn-outline-light btn-sm file-detail-download-button file-detail-icon-button"
                    disabled={shareState.loading}
                    onClick={() => void onDownloadFile()}
                    aria-label={shareSupported ? 'Share file' : 'Download file'}
                    title={shareSupported ? 'Share file' : 'Download file'}
                  >
                    <svg
                      className="file-detail-download-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      {shareSupported ? (
                        <>
                          <path d="M12 3v12" />
                          <path d="M8 7l4-4 4 4" />
                          <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
                        </>
                      ) : (
                        <>
                          <path d="M12 3v10" />
                          <path d="M8 9l4 4 4-4" />
                          <path d="M5 21h14" />
                        </>
                      )}
                    </svg>
                    <span className="file-detail-button-text">
                      {shareSupported ? 'Share' : 'Download'}
                    </span>
                  </button>
                  {voteSystemEnabled ? (
                    <VoteControl
                      voteScore={voteScore}
                      cooldownText={voteCooldownText}
                      busy={voteState.loading}
                      onVote={onVote}
                    />
                  ) : null}
                  <button
                    className="btn btn-outline-danger btn-sm file-detail-delete-button file-detail-icon-button"
                    disabled={deleteState.loading}
                    onClick={() => void onDeleteFile(selectedFile.id)}
                    aria-label={
                      deleteState.loading ? 'Deleting file' : 'Delete file'
                    }
                    title="Delete file"
                  >
                    <svg
                      className="file-detail-delete-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3 6h18" />
                      <path d="M8 6V4h8v2" />
                      <path d="M6 6l1 14h10l1-14" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                    </svg>
                    <span className="file-detail-button-text">Delete file</span>
                  </button>
                </div>
              </div>
              <div className="text-muted-foreground text-sm">
                <span className="font-semibold file-detail-label">
                  File name:
                </span>{' '}
                {selectedFileName}
                <br />
                {formatDuration(selectedFile.durationMs)}
                {selectedFile.durationMs ? <br /> : null}
                <span className="font-semibold file-detail-label">
                  Type:
                </span>{' '}
                {selectedFileType}
                <br />
                <span className="font-semibold file-detail-label">
                  Size:
                </span>{' '}
                {formatSizeMb(selectedFile.sizeBytes)}
                {selectedFile.width && selectedFile.height
                  ? ` (${selectedFile.width}×${selectedFile.height})`
                  : ''}
                <br />
                <span className="font-semibold file-detail-label">
                  Modified:
                </span>{' '}
                {formatDateTime(selectedFile.mtime)}
                {voteSystemEnabled ? (
                  <>
                    <br />
                    <span className="font-semibold file-detail-label">
                      Score:
                    </span>{' '}
                    <span
                      data-test-id="vote-score"
                      className="file-detail-vote-score"
                    >
                      {voteScore > 0 ? `+${voteScore}` : voteScore}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="file-detail-section-divider" />
            <div className="file-detail-tags file-detail-section mb-4">
              <div className="flex justify-between items-center mb-2">
                <div className="uppercase font-semibold file-detail-section-title">
                  Tags
                </div>
                <div className="flex gap-2">
                  <button
                    className={`btn btn-outline-light btn-sm file-detail-refresh-button file-detail-icon-button${
                      tagState.loading ? ' is-loading' : ''
                    }`}
                    onClick={() => void onRefreshTags()}
                    disabled={tagState.loading}
                    aria-label="Refresh tags"
                  >
                    <svg
                      className="file-detail-refresh-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      <path d="M21 3v6h-6" />
                    </svg>
                    <span className="file-detail-button-text">Refresh</span>
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 items-center mb-2">
                <input
                  className="form-control form-control-sm bg-background text-foreground border-secondary"
                  style={{ maxWidth: 220 }}
                  placeholder="Add tag"
                  value={manualTagInput}
                  onChange={(event) =>
                    onManualTagInputChange(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void onAddManualTag();
                    }
                  }}
                />
                <select
                  className="form-select form-select-sm bg-background text-foreground border-secondary"
                  style={{ maxWidth: 160 }}
                  value={manualTagCategory}
                  onChange={(event) =>
                    onManualTagCategoryChange(event.target.value)
                  }
                >
                  <option value="general">general</option>
                  <option value="artist">artist</option>
                  <option value="character">character</option>
                  <option value="copyright">copyright</option>
                  <option value="species">species</option>
                  <option value="meta">meta</option>
                  <option value="lore">lore</option>
                  <option value="invalid">invalid</option>
                </select>
                <button
                  className="btn btn-outline-light btn-sm"
                  onClick={() => void onAddManualTag()}
                >
                  Add
                </button>
              </div>
              {tagState.error ? (
                <div className="text-destructive text-sm mb-2">
                  {tagState.error}
                </div>
              ) : null}
              {tagState.loading ? (
                <div className="text-muted-foreground text-sm mb-2">
                  Updating tags…
                </div>
              ) : null}
              {tagGroups.length === 0 ? (
                <div className="text-muted-foreground text-sm">
                  No tags yet.
                </div>
              ) : (
                tagGroups.map((group) => (
                  <div key={group.category} className="mb-2">
                    <div className="text-sm font-semibold uppercase mb-1 file-detail-subtitle">
                      {group.category}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {group.tags.map((tag) => {
                        const sources = Array.from(tag.sources).join(', ');
                        const scoreText =
                          tag.score !== null
                            ? `score ${tag.score}`
                            : 'score n/a';
                        return (
                          <span
                            key={`${group.category}-${tag.tag}`}
                            className="badge bg-secondary text-foreground file-tag-pill"
                            title={`${sources} • ${scoreText}`}
                          >
                            {tag.tag}
                            {tag.hasManual ? (
                              <button
                                className="btn btn-link btn-sm p-0 ml-2 text-foreground file-tag-remove"
                                onClick={() =>
                                  void onRemoveManualTag(
                                    tag.tag,
                                    group.category
                                  )
                                }
                                aria-label={`Remove ${tag.tag}`}
                              >
                                ×
                              </button>
                            ) : null}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
              <div className="text-muted-foreground text-sm mt-2">
                <span className="file-detail-label">Sources:</span>{' '}
                {tagSourceSummary}
              </div>
            </div>
            <div className="file-detail-section-divider" />
            <div className="file-detail-section mb-4">
              <div className="file-detail-section-head">
                <div className="uppercase font-semibold file-detail-section-title">
                  Sauces
                </div>
                <button
                  className="btn btn-outline-light btn-sm file-detail-scan-button file-detail-icon-button"
                  disabled={providerState.loading}
                  onClick={() => void onRunAllProviders()}
                  aria-label="Scan with SauceNAO and Fluffle"
                >
                  <svg
                    className="file-detail-scan-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="6" />
                    <path d="M16 16l5 5" />
                  </svg>
                  <span className="file-detail-button-text">Scan</span>
                </button>
              </div>
              <div className="text-muted-foreground text-sm mb-4">
                <div>
                  <span className="font-semibold file-detail-label">
                    Provider scans:
                  </span>{' '}
                  {providerMeta?.hasRuns
                    ? `last run ${formatDateTime(providerMeta.latestRunAt)}`
                    : 'never run yet'}
                </div>
                {providerMeta?.missingProviders.length ? (
                  <div>
                    <span className="font-semibold file-detail-label">
                      Missing:
                    </span>{' '}
                    {providerMeta.missingProviders.join(', ')}
                  </div>
                ) : null}
                <div>
                  <span className="font-semibold file-detail-label">
                    Next auto-scan:
                  </span>{' '}
                  {nextAutoScanText}
                </div>
              </div>
            </div>
            {providerState.error ? (
              <div className="text-destructive text-sm mb-2">
                {providerState.error}
              </div>
            ) : null}
            {voteState.error ? (
              <div className="text-destructive text-sm mb-2">
                {voteState.error}
              </div>
            ) : null}
            <div className="file-detail-topmatches mb-4">
              {matchRemoveState.error ? (
                <div className="text-destructive text-sm mb-2">
                  {matchRemoveState.error}
                </div>
              ) : null}
              {providerHighlights.length ? (
                <div className="file-detail-topmatches-list">
                  {providerHighlights.map((item) => (
                    <a
                      key={item.id}
                      className="file-detail-topmatches-card text-decoration-none border border-secondary rounded p-2 bg-background text-foreground"
                      href={item.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <button
                        type="button"
                        className="file-detail-topmatches-remove"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void onRemoveTopMatch(item.sourceUrl);
                        }}
                        disabled={matchRemoveState.loading}
                        aria-label={`Remove ${item.sourceName}`}
                      >
                        ×
                      </button>
                      <div className="text-muted-foreground text-sm">
                        {item.provider}
                      </div>
                      <div
                        className="font-semibold truncate"
                        title={item.sourceName}
                      >
                        {item.sourceName}
                      </div>
                      <div className="text-muted-foreground text-sm">
                        {(() => {
                          const value = item.score;
                          const label = 'score';
                          return value !== null
                            ? `${label} ${value}`
                            : `${label} n/a`;
                        })()}
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground text-sm">
                  {!providerMeta?.hasRuns
                    ? 'No scan results yet.'
                    : displayFilterActive
                      ? 'No matches for selected sauces yet.'
                      : 'No high-confidence matches yet.'}
                </div>
              )}
            </div>
          </div>
        </div>
        <FileDetailPreview
          file={nextLoadedFile}
          direction="next"
          voteSystemEnabled={voteSystemEnabled}
        />
      </div>
      {/* Outside the track: a per-panel control would travel with the swipe,
          and the neighbour's copy shows the wrong icon mid-gesture. */}
      {mediaFullscreen ? fullscreenToggle : null}
    </div>
  );
}
