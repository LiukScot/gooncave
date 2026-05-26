import React from 'react';
import type { FileItem } from '@/api';

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
  selectedFileFavorite: boolean;

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
  onDetailTouchMove: React.TouchEventHandler<HTMLDivElement>;
  onDetailTouchEnd: React.TouchEventHandler<HTMLDivElement>;

  // Action states
  shareState: FetchState;
  favoriteState: FetchState;
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
  onDownloadFile: () => void;
  onToggleFavorite: () => void;
  onDeleteFile: (id: string) => void;
  onClose: () => void;
  onGoRelative: (delta: number) => void;

  // Render helpers
  renderNeighborPreview: (file: FileItem | null, direction: 'prev' | 'next') => React.ReactNode;
  renderFileMedia: (file: FileItem) => React.ReactNode;
  formatDateTime: (value: string | null | undefined) => string;
};

export function FileDetailPanel(props: Props): React.ReactElement {
  const {
    selectedFile,
    selectedFileName,
    selectedFileType,
    selectedFileFavorite,
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
    onDetailTouchMove,
    onDetailTouchEnd,
    shareState,
    favoriteState,
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
    onDownloadFile,
    onToggleFavorite,
    onDeleteFile,
    onClose,
    onGoRelative,
    renderNeighborPreview,
    renderFileMedia,
    formatDateTime,
  } = props;

  return (
    <div
      ref={detailSwipeFrameRef}
      className={`file-detail-frame${mediaFullscreen ? ' is-fullscreen' : ''}`}
      onTouchStart={onDetailTouchStart}
      onTouchMove={onDetailTouchMove}
      onTouchEnd={onDetailTouchEnd}
      onTouchCancel={onDetailTouchEnd}
    >
      <div
        className={`file-detail-track${detailSwipeTransition ? ' is-transitioning' : ''}`}
        style={{ transform: `translate3d(calc(-100% + ${detailSwipeOffset}px), 0, 0)` }}
      >
        {renderNeighborPreview(prevLoadedFile, 'prev')}
        <div className={`file-detail-panel file-detail-panel-current file-detail-layer text-foreground${selectedFile.mediaType === 'VIDEO' ? ' is-video' : ''}`}>
          <div className="container file-detail-back-bar">
            <button className="file-detail-back-btn" onClick={onClose}>
              <svg className="file-detail-back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
              Back to gallery
            </button>
            <div className="flex items-center gap-2 ml-auto file-detail-sequence-controls">
              <button
                className="btn btn-outline-secondary btn-sm"
                onClick={() => onGoRelative(-1)}
                disabled={!hasPrev}
                aria-label="Previous"
              >
                ‹ Prev
              </button>
              <button
                className="btn btn-outline-secondary btn-sm"
                onClick={() => onGoRelative(1)}
                disabled={!hasNext}
                aria-label="Next"
              >
                Next ›
              </button>
            </div>
          </div>
          <div
            className={`file-detail-media-wrap${mediaFullscreen ? ' is-fullscreen' : ''}`}
            onClick={(e) => {
              if (mediaFullscreen && e.target === e.currentTarget) onToggleFullscreen();
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
            <button
              className="file-detail-fullscreen-btn"
              onClick={onToggleFullscreen}
              aria-label={mediaFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
              title={mediaFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
            >
              <svg className="file-detail-fullscreen-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
          </div>
          <div className="container file-detail-body">
        <div className="file-detail-section mb-4">
          <div className="file-detail-section-head">
            <div className="uppercase font-semibold file-detail-section-title file-detail-section-title-accent">
              File info
            </div>
            <div className="file-detail-section-actions">
              <button
                className="btn btn-outline-light btn-sm file-detail-download-button file-detail-icon-button"
                disabled={shareState.loading}
                onClick={() => void onDownloadFile()}
                aria-label="Download file"
                title="Download file"
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
                  <path d="M12 3v10" />
                  <path d="M8 9l4 4 4-4" />
                  <path d="M5 21h14" />
                </svg>
                <span className="file-detail-button-text">Download</span>
              </button>
              <button
                className={`btn btn-outline-warning btn-sm file-detail-favorite-button file-detail-icon-button${
                  selectedFileFavorite ? ' is-favorite' : ''
                }`}
                disabled={favoriteState.loading}
                onClick={() => void onToggleFavorite()}
                aria-label={selectedFileFavorite ? 'Unfavorite file' : 'Favorite file'}
                aria-pressed={selectedFileFavorite}
                title={selectedFileFavorite ? 'Unfavorite file' : 'Favorite file'}
              >
                <svg
                  className="file-detail-favorite-icon file-detail-favorite-icon-outline"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 3.5l2.95 5.98 6.6.96-4.77 4.65 1.12 6.53L12 17.8l-5.9 3.32 1.12-6.53-4.77-4.65 6.6-.96L12 3.5z" />
                </svg>
                <svg
                  className="file-detail-favorite-icon file-detail-favorite-icon-filled"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 3.5l2.95 5.98 6.6.96-4.77 4.65 1.12 6.53L12 17.8l-5.9 3.32 1.12-6.53-4.77-4.65 6.6-.96L12 3.5z" />
                </svg>
                <span className="file-detail-button-text">Favorite</span>
              </button>
              <button
                className="btn btn-outline-danger btn-sm file-detail-delete-button file-detail-icon-button"
                disabled={deleteState.loading}
                onClick={() => void onDeleteFile(selectedFile.id)}
                aria-label={deleteState.loading ? 'Deleting file' : 'Delete file'}
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
            <span className="font-semibold file-detail-label">File name:</span> {selectedFileName}
            <br />
            {selectedFile.durationMs ? `${(selectedFile.durationMs / 1000).toFixed(1)}s` : ''}
            {selectedFile.durationMs ? <br /> : null}
            <span className="font-semibold file-detail-label">Type:</span> {selectedFileType}
            <br />
            <span className="font-semibold file-detail-label">Size:</span>{' '}
            {(selectedFile.sizeBytes / 1024 / 1024).toFixed(2)} MB
            {selectedFile.width && selectedFile.height ? ` (${selectedFile.width}×${selectedFile.height})` : ''}
            <br />
            <span className="font-semibold file-detail-label">Modified:</span> {formatDateTime(selectedFile.mtime)}
          </div>
        </div>
        <div className="file-detail-section-divider" />
        <div className="file-detail-tags file-detail-section mb-4">
          <div className="flex justify-between items-center mb-2">
            <div className="uppercase font-semibold file-detail-section-title file-detail-section-title-accent">
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
              onChange={(event) => onManualTagInputChange(event.target.value)}
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
              onChange={(event) => onManualTagCategoryChange(event.target.value)}
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
            <button className="btn btn-outline-light btn-sm" onClick={() => void onAddManualTag()}>
              Add
            </button>
          </div>
          {tagState.error ? <div className="text-destructive text-sm mb-2">{tagState.error}</div> : null}
          {tagState.loading ? <div className="text-muted-foreground text-sm mb-2">Updating tags…</div> : null}
          {tagGroups.length === 0 ? (
            <div className="text-muted-foreground text-sm">No tags yet.</div>
          ) : (
            tagGroups.map((group) => (
              <div key={group.category} className="mb-2">
                <div className="text-sm font-semibold uppercase mb-1 file-detail-subtitle">
                  {group.category}
                </div>
                <div className="flex flex-wrap gap-2">
                  {group.tags.map((tag) => {
                    const sources = Array.from(tag.sources).join(', ');
                    const scoreText = tag.score !== null ? `score ${tag.score}` : 'score n/a';
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
                            onClick={() => void onRemoveManualTag(tag.tag, group.category)}
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
            <span className="file-detail-label">Sources:</span> {tagSourceSummary}
          </div>
        </div>
        <div className="file-detail-section-divider" />
        <div className="file-detail-section mb-4">
          <div className="file-detail-section-head">
            <div className="uppercase font-semibold file-detail-section-title file-detail-section-title-accent">
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
              <span className="font-semibold file-detail-label">Provider scans:</span>{' '}
              {providerMeta?.hasRuns ? `last run ${formatDateTime(providerMeta.latestRunAt)}` : 'never run yet'}
            </div>
            {providerMeta?.missingProviders.length ? (
              <div>
                <span className="font-semibold file-detail-label">Missing:</span>{' '}
                {providerMeta.missingProviders.join(', ')}
              </div>
            ) : null}
            <div>
              <span className="font-semibold file-detail-label">Next auto-scan:</span> {nextAutoScanText}
            </div>
          </div>
        </div>
        {providerState.error ? <div className="text-destructive text-sm mb-2">{providerState.error}</div> : null}
        {favoriteState.error ? <div className="text-destructive text-sm mb-2">{favoriteState.error}</div> : null}
        {deleteState.error ? <div className="text-destructive text-sm mb-2">{deleteState.error}</div> : null}
        <div className="file-detail-topmatches mb-4">
          {matchRemoveState.error ? (
            <div className="text-destructive text-sm mb-2">{matchRemoveState.error}</div>
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
                  <div className="text-muted-foreground text-sm">{item.provider}</div>
                  <div className="font-semibold truncate" title={item.sourceName}>
                    {item.sourceName}
                  </div>
                  <div className="text-muted-foreground text-sm">
                    {(() => {
                      const value = item.score;
                      const label = 'score';
                      return value !== null ? `${label} ${value}` : `${label} n/a`;
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
        {renderNeighborPreview(nextLoadedFile, 'next')}
      </div>
    </div>
  );
}
