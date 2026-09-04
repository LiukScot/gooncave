import { ChevronDown, ChevronLeft, ChevronUp, Trash2 } from 'lucide-react';
import React from 'react';

import {
  FileInfoList,
  OverlayButton,
  SauceCards,
  TagPills
} from './DetailSections';
import { FileDetailPreview } from './FileDetailPreview';
import { useMediaZoom } from './useMediaZoom';
import { VoteControl } from './VoteControl';

import { API_BASE, type FileItem } from '@/api';
import { withShortcutHint } from '@/features/shortcuts/shortcuts';
import { useShortcuts } from '@/features/shortcuts/useShortcuts';
import { formatDateTime } from '@/lib/format';

export type FetchState = {
  loading: boolean;
  error: string | null;
};

export type TagEntry = {
  /** What the pill shows: the tag every original in the group collapses to. */
  tag: string;
  /**
   * The stored tags behind the pill. More than one means an alias merged
   * them, and removing the pill has to take all of them.
   */
  originals: readonly string[];
  category: string;
  sources: ReadonlySet<string>;
  score: number | null;
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

export type PreviewSections = {
  tagGroups: readonly TagGroup[];
  tagSourceSummary: string;
  providerHighlights: readonly ProviderHighlight[];
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
  /** Tags and matches for the neighbours, so a swipe slides in filled. */
  prevSections: PreviewSections;
  nextSections: PreviewSections;
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
  impliedTags: readonly string[];
  tagSourceSummary: string;
  tagsEditing: boolean;
  manualTagInput: string;
  manualTagCategory: string;
  onManualTagInputChange: (value: string) => void;
  onManualTagCategoryChange: (value: string) => void;
  onAddManualTag: () => void;
  onToggleTagsEditing: () => void;
  onRemoveTag: (entry: TagEntry) => void;
  onSelectTag: (tag: string) => void;
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
  onClose: () => void;
  onGoRelative: (delta: number) => void;

  // Render helper for the active media (image/video). FileDetailPreview is
  // imported directly so the parent doesn't have to pass a render callback.
  renderFileMedia: (file: FileItem) => React.ReactNode;
};

export function FileDetailPanel(props: Props): React.ReactElement {
  const {
    selectedFile,
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
    prevSections,
    nextSections,
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
    impliedTags,
    tagSourceSummary,
    tagsEditing,
    manualTagInput,
    manualTagCategory,
    onManualTagInputChange,
    onManualTagCategoryChange,
    onAddManualTag,
    onToggleTagsEditing,
    onRemoveTag,
    onSelectTag,
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
    onClose,
    onGoRelative,
    renderFileMedia
  } = props;

  // The tooltips carry the live binding rather than a hardcoded key, so a
  // remapped shortcut is discoverable from the button it drives (issue #282).
  const shortcuts = useShortcuts();
  const zoom = useMediaZoom(mediaFullscreen, selectedFile.id);

  // Back leaves fullscreen first and only then the file, so one press never
  // does both — the same order Esc follows.
  const backButton = (
    <OverlayButton
      icon={ChevronLeft}
      className="file-detail-overlay-back"
      label="Back"
      title={mediaFullscreen ? 'Leave fullscreen' : 'Back to gallery'}
      onClick={mediaFullscreen ? onToggleFullscreen : onClose}
    />
  );

  // Only rendered in fullscreen: everywhere else the info section below the
  // picture already carries these, in the same order.
  const fullscreenActions = (
    <div className="file-detail-overlay-actions">
      {voteSystemEnabled && !voteCooldownText ? (
        <>
          <OverlayButton
            icon={ChevronUp}
            label={withShortcutHint('Vote up', shortcuts.voteUp)}
            disabled={voteState.loading}
            onClick={() => onVote(1)}
          />
          {/* A local score never goes below zero, so at zero there is
              nothing to vote down. */}
          {voteScore > 0 ? (
            <OverlayButton
              icon={ChevronDown}
              label={withShortcutHint('Vote down', shortcuts.voteDown)}
              disabled={voteState.loading}
              onClick={() => onVote(-1)}
            />
          ) : null}
        </>
      ) : null}
      <OverlayButton
        icon={Trash2}
        danger
        label={withShortcutHint('Delete file', shortcuts.delete)}
        disabled={deleteState.loading}
        onClick={() => onDeleteFile(selectedFile.id)}
      />
    </div>
  );

  const fullscreenToggle = (
    <button
      className="file-detail-overlay-btn file-detail-fullscreen-btn"
      onClick={onToggleFullscreen}
      aria-label={mediaFullscreen ? 'Exit fullscreen' : 'View fullscreen'}
      title={withShortcutHint(
        mediaFullscreen ? 'Exit fullscreen' : 'View fullscreen',
        shortcuts.fullscreen
      )}
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
        <div className="floating-capsule file-detail-vote-undo" role="status">
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
          sections={prevSections}
        />
        <div
          className={`file-detail-panel file-detail-panel-current file-detail-layer text-foreground${selectedFile.mediaType === 'VIDEO' ? ' is-video' : ''}`}
        >
          <div
            ref={zoom.wrapRef}
            className={`file-detail-media-wrap${mediaFullscreen ? ' is-fullscreen' : ''}${zoom.zoomed ? ' is-zoomed' : ''}`}
            {...zoom.handlers}
            onDoubleClick={zoom.reset}
            style={
              {
                '--file-detail-zoom': zoom.transform ?? 'none',
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
              // A zoomed picture is being examined, not dismissed: clicking
              // the letterboxing around it must not drop out of fullscreen
              // and lose the magnification.
              if (
                mediaFullscreen &&
                !zoom.zoomed &&
                e.target === e.currentTarget
              )
                onToggleFullscreen();
            }}
          >
            <button
              className={`file-detail-nav file-detail-nav-left${navPeek ? ' file-detail-nav-peek' : ''}`}
              onClick={() => onGoRelative(-1)}
              disabled={!hasPrev}
              aria-label="Previous"
              title={withShortcutHint('Previous file', shortcuts.prev)}
            >
              ‹
            </button>
            <button
              className={`file-detail-nav file-detail-nav-right${navPeek ? ' file-detail-nav-peek' : ''}`}
              onClick={() => onGoRelative(1)}
              disabled={!hasNext}
              aria-label="Next"
              title={withShortcutHint('Next file', shortcuts.next)}
            >
              ›
            </button>
            {renderFileMedia(selectedFile)}
            {mediaFullscreen ? null : backButton}
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
                  </button>
                  {voteSystemEnabled ? (
                    <VoteControl
                      voteScore={voteScore}
                      cooldownText={voteCooldownText}
                      busy={voteState.loading}
                      onVote={onVote}
                      upHint={withShortcutHint('Vote up', shortcuts.voteUp)}
                      downHint={withShortcutHint(
                        'Vote down',
                        shortcuts.voteDown
                      )}
                    />
                  ) : null}
                  <button
                    className="btn btn-outline-danger btn-sm file-detail-delete-button file-detail-icon-button"
                    disabled={deleteState.loading}
                    onClick={() => void onDeleteFile(selectedFile.id)}
                    aria-label={
                      deleteState.loading ? 'Deleting file' : 'Delete file'
                    }
                    title={withShortcutHint('Delete file', shortcuts.delete)}
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
                  </button>
                </div>
              </div>
              <FileInfoList
                file={selectedFile}
                voteSystemEnabled={voteSystemEnabled}
                testId="vote-score"
              />
            </div>
            <div className="file-detail-section-divider" />
            <div className="file-detail-tags file-detail-section mb-4">
              <div className="file-detail-section-head">
                <div className="uppercase font-semibold file-detail-section-title">
                  Tags
                </div>
                <div className="flex gap-2">
                  <button
                    className={`btn btn-outline-light btn-sm file-detail-edit-tags-button file-detail-icon-button${
                      tagsEditing ? ' is-active' : ''
                    }`}
                    onClick={onToggleTagsEditing}
                    aria-pressed={tagsEditing}
                    aria-label={tagsEditing ? 'Done editing tags' : 'Edit tags'}
                  >
                    <svg
                      className="file-detail-edit-tags-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                    </svg>
                  </button>
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
              <TagPills
                groups={tagGroups}
                implied={impliedTags}
                sourceSummary={tagSourceSummary}
                editing={tagsEditing}
                onRemoveTag={onRemoveTag}
                onSelectTag={onSelectTag}
              />
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
              <SauceCards
                highlights={providerHighlights}
                removeDisabled={matchRemoveState.loading}
                onRemoveTopMatch={(sourceUrl) =>
                  void onRemoveTopMatch(sourceUrl)
                }
                emptyLabel={
                  !providerMeta?.hasRuns
                    ? 'No scan results yet.'
                    : displayFilterActive
                      ? 'No matches for selected sauces yet.'
                      : 'No high-confidence matches yet.'
                }
              />
            </div>
          </div>
        </div>
        <FileDetailPreview
          file={nextLoadedFile}
          direction="next"
          voteSystemEnabled={voteSystemEnabled}
          sections={nextSections}
        />
      </div>
      {/* Outside the track: a per-panel control would travel with the swipe,
          and the neighbour's copy shows the wrong icon mid-gesture. */}
      {mediaFullscreen ? backButton : null}
      {mediaFullscreen ? fullscreenActions : null}
      {mediaFullscreen ? fullscreenToggle : null}
    </div>
  );
}
