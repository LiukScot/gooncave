import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Clock,
  Share2
} from 'lucide-react';
import React, { useState } from 'react';

import {
  FileInfoList,
  OverlayButton,
  RelatedPostsSection,
  TagPills
} from './DetailSections';
import { KeepOnDeviceButton } from './KeepOnDeviceButton';
import { SourcesDialog } from './SourcesDialog';
import { SourceTextSection, useFileSourceText } from './SourceTextSection';
import { useMediaZoom } from './useMediaZoom';
import { useRelatedPosts } from './useRelatedPosts';
import { useTouchOverlay } from './useTouchOverlay';

import {
  API_BASE,
  type FavoriteSourceLink,
  type FileItem,
  type FileTagRefreshStatus
} from '@/api';
import { FileComments } from '@/features/explore/ExploreComments';
import { useOpenBooruPost } from '@/features/explore/useOpenBooruPost';
import { PoolNavigators } from '@/features/pools/PoolNavigators';
import { usePoolNavigators } from '@/features/pools/usePoolNavigators';
import { withShortcutHint } from '@/features/shortcuts/shortcuts';
import { useShortcuts } from '@/features/shortcuts/useShortcuts';
import { useImageTheme } from '@/lib/materialTheme';

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
  /**
   * The file gets this tag for free, from an implication of one it actually
   * carries. Nothing stored it, so there is nothing for the pen to remove.
   */
  implied?: boolean;
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
  tagRefreshStatus: FileTagRefreshStatus | null;
  providerState: FetchState;

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

  // Provider / source
  providerHighlights: readonly ProviderHighlight[];
  favoriteSourceLinks: readonly FavoriteSourceLink[];
  providerMeta: ProviderMeta | null;
  nextAutoScanText: string;
  displayFilterActive: boolean;
  onRunAllProviders: () => void;

  // File actions
  shareSupported: boolean;
  onDownloadFile: () => void;
  onVote: (value: 1 | -1) => void;
  onUndoVote: () => void;
  onDeleteFile: (id: string) => void;
  /** The original is on this device now, after "Keep on this device" downloaded it. */
  onFileKept: (id: string, locationType: FileItem['locationType']) => void;
  onClose: () => void;
  onGoRelative: (delta: number) => void;

  // Render helper for the active media (image/video).
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
    tagRefreshStatus,
    providerState,
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
    favoriteSourceLinks,
    providerMeta,
    nextAutoScanText,
    displayFilterActive,
    onRunAllProviders,
    shareSupported,
    onDownloadFile,
    onVote,
    onUndoVote,
    onDeleteFile,
    onFileKept,
    onClose,
    onGoRelative,
    renderFileMedia
  } = props;

  // The tooltips carry the live binding rather than a hardcoded key, so a
  // remapped shortcut is discoverable from the button it drives (issue #282).
  const shortcuts = useShortcuts();
  const zoom = useMediaZoom(mediaFullscreen, selectedFile.id);
  const overlay = useTouchOverlay(`${selectedFile.id}:${mediaFullscreen}`);
  // The booru group this file's post belongs to. Read on open: the grid only
  // knows *that* there is one, never which posts are in it.
  const related = useRelatedPosts({ kind: 'file', fileId: selectedFile.id });
  const openBooruPost = useOpenBooruPost();
  // The pools this file's post is a page of, read on open like the group
  // above: nothing local knows about a booru's reading order.
  const pools = usePoolNavigators({ kind: 'file', fileId: selectedFile.id });
  // Closed until asked for: the file's own details are the least read part
  // of the page. Kept across files, so it stays the way the reader left it.
  const [infoOpen, setInfoOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const sourceTexts = useFileSourceText(selectedFile.id);
  useImageTheme(
    selectedFile.thumbUrl ? `${API_BASE}${selectedFile.thumbUrl}` : null
  );
  // A cooldown takes the pair's place as a clock, two buttons wide.
  const voteOverlay = !voteSystemEnabled ? null : voteCooldownText ? (
    <div
      className="file-detail-overlay-btn file-detail-overlay-cooldown"
      role="group"
      aria-label="Vote"
      title={`Votable again in ${voteCooldownText}`}
    >
      <Clock className="file-detail-overlay-icon" aria-hidden="true" />
      {voteCooldownText}
    </div>
  ) : (
    <div className="file-detail-overlay-group" role="group" aria-label="Vote">
      <OverlayButton
        icon={ChevronUp}
        label="Vote up"
        title={withShortcutHint('Vote up', shortcuts.voteUp)}
        disabled={voteState.loading}
        onClick={() => onVote(1)}
      />
      {/* A local score never goes below zero, so at zero there is
          nothing to vote down. */}
      {voteScore > 0 ? (
        <OverlayButton
          icon={ChevronDown}
          label="Vote down"
          title={withShortcutHint('Vote down', shortcuts.voteDown)}
          disabled={voteState.loading}
          onClick={() => onVote(-1)}
        />
      ) : null}
    </div>
  );

  // Never in fullscreen: there the picture is the whole screen, and the way
  // back out of that is the fullscreen toggle, not a second arrow.
  const backButton = (
    <OverlayButton
      icon={ChevronLeft}
      className="file-detail-overlay-back"
      label="Back to gallery"
      onClick={onClose}
    />
  );

  const fullscreenActions = voteOverlay ? (
    <div className="file-detail-overlay-actions">{voteOverlay}</div>
  ) : null;

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

  // The open file and its two neighbours are drawn by this one function, so
  // a control added here is on all three: the neighbour that slides in during
  // a swipe cannot lack a button the file it becomes will have. A neighbour
  // is `inert` and made of its thumbnail and already-fetched tags.
  const renderLayer = (
    file: FileItem | null,
    direction: 'prev' | 'next' | null,
    sections: PreviewSections
  ) => {
    if (!file) {
      return (
        <div
          className={`file-detail-panel file-detail-panel-preview file-detail-panel-${direction}`}
          aria-hidden="true"
        />
      );
    }
    const active = direction === null;
    return (
        <div
          className={`file-detail-panel ${
            active ? 'file-detail-panel-current' : `file-detail-panel-preview file-detail-panel-${direction}`
          } file-detail-layer${active ? '' : ' file-detail-preview-shell'} text-foreground${file.mediaType === 'VIDEO' ? ' is-video' : ''}`}
          aria-hidden={active ? undefined : true}
          inert={active ? undefined : true}
        >
          <div
            ref={active ? zoom.wrapRef : undefined}
            className={`file-detail-media-wrap${active && mediaFullscreen ? ' is-fullscreen' : ''}${active && zoom.zoomed ? ' is-zoomed' : ''}`}
            {...(active ? zoom.handlers : {})}
            onDoubleClick={(e) => {
              // On the picture itself, not the letterboxing: the first click
              // of a double click there has already left fullscreen, and
              // this would walk straight back in.
              if (
                !mediaFullscreen &&
                (e.target instanceof HTMLImageElement ||
                  e.target instanceof HTMLVideoElement)
              ) {
                onToggleFullscreen();
                return;
              }
              zoom.reset();
            }}
            style={
              {
                '--file-detail-zoom': (active && zoom.transform) || 'none',
                // Stand-in while the original decodes; the preview panels
                // already put this thumbnail in cache.
                '--file-detail-poster': file.thumbUrl
                  ? `url("${encodeURI(`${API_BASE}${file.thumbUrl}`)}")`
                  : 'none',
                // Reserve the box in the file's real shape. A fixed
                // min-height reserves the wrong shape, so the placeholder is
                // letterboxed differently from the original and the picture
                // visibly resizes once it loads.
                '--file-detail-aspect':
                  file.width && file.height
                    ? `${file.width} / ${file.height}`
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
            {active ? (
              <>
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
              </>
            ) : null}
            {active ? (
              renderFileMedia(file)
            ) : file.thumbUrl ? (
              // Thumbnail, never the original: these off-screen neighbours are
              // decorative and used to pull the full file (three per open, more
              // on every swipe), which is unusable on a metered connection.
              // Not lazy: they sit outside the viewport, and in fullscreen they
              // are display:none, so a lazy image would never load and a swipe
              // would wait on the network.
              <img
                src={`${API_BASE}${file.thumbUrl}`}
                alt=""
                className="file-detail-media"
                decoding="async"
              />
            ) : null}
            {mediaFullscreen ? null : backButton}
            {!active || mediaFullscreen || !voteOverlay ? null : (
              <div className="file-detail-overlay-row">{voteOverlay}</div>
            )}
            {mediaFullscreen ? null : fullscreenToggle}
          </div>
          <div className={`container file-detail-body${active ? '' : ' file-detail-preview-body'}`}>
            {active ? (
              <>
                <PoolNavigators pools={pools.pools} />
                <RelatedPostsSection
                  posts={related.posts}
                  loading={related.loading}
                  expected={Boolean(file.hasRelations)}
                  onOpen={openBooruPost}
                />
                <SourceTextSection {...sourceTexts} />
              </>
            ) : null}
            <div className="file-detail-section-divider" />
            <div className="file-detail-section mb-4">
              <div className="file-detail-section-head">
                <button
                  type="button"
                  className="uppercase font-semibold file-detail-section-title file-detail-section-toggle"
                  aria-expanded={active && infoOpen}
                  onClick={() => setInfoOpen((open) => !open)}
                >
                  File info
                  <ChevronDown
                    className={`file-detail-section-toggle-icon${active && infoOpen ? ' is-open' : ''}`}
                    aria-hidden="true"
                  />
                </button>
                <div className="file-detail-section-actions">
                  <button
                    type="button"
                    className="btn btn-outline-light btn-sm file-detail-icon-button"
                    aria-label="Share post link"
                    title="Sources: share or open the posts this file was found at"
                    onClick={() => setSourcesOpen(true)}
                  >
                    <Share2 className="size-4" aria-hidden="true" />
                  </button>
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
                  <KeepOnDeviceButton file={file} onKept={onFileKept} />
                  <button
                    className="btn btn-outline-danger btn-sm file-detail-delete-button file-detail-icon-button"
                    disabled={deleteState.loading}
                    onClick={() => void onDeleteFile(file.id)}
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
              {active && infoOpen ? (
                <FileInfoList
                  file={file}
                  voteSystemEnabled={voteSystemEnabled}
                  testId="vote-score"
                />
              ) : null}
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
                      active && tagsEditing ? ' is-active' : ''
                    }`}
                    onClick={onToggleTagsEditing}
                    aria-pressed={active && tagsEditing}
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
                      active && tagState.loading ? ' is-loading' : ''
                    }`}
                    onClick={() => void onRefreshTags()}
                    disabled={active && tagState.loading}
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
                  aria-label="Tag name"
                  name="manual-tag"
                  type="text"
                  autoComplete="off"
                  value={active ? manualTagInput : ''}
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
                  aria-label="Tag category"
                  name="manual-tag-category"
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
              {active && tagState.loading ? (
                <div className="text-muted-foreground text-sm mb-2">
                  {tagRefreshStatus === 'queued'
                    ? 'Tag refresh queued…'
                    : 'Updating tags…'}
                </div>
              ) : null}
              {active && !tagState.loading && tagRefreshStatus === 'done' ? (
                <div className="text-muted-foreground text-sm mb-2">
                  Tags updated.
                </div>
              ) : null}
              <TagPills
                groups={sections.tagGroups}
                implied={active ? impliedTags : undefined}
                sourceSummary={sections.tagSourceSummary}
                editing={active && tagsEditing}
                onRemoveTag={onRemoveTag}
                onSelectTag={onSelectTag}
              />
            </div>
            {active ? <FileComments fileId={file.id} /> : null}
            {active && voteState.error ? (
              <div className="text-destructive text-sm mb-2">
                {voteState.error}
              </div>
            ) : null}
          </div>
        </div>
    );
  };

  return (
    <div
      ref={detailSwipeFrameRef}
      data-overlay-actions={!voteSystemEnabled ? 0 : voteCooldownText || voteScore > 0 ? 2 : 1}
      className={`file-detail-frame${overlay.active ? ' is-overlay-active' : ''}${mediaFullscreen ? ' is-fullscreen' : ''}${
        selectedFile.mediaType === 'VIDEO' ? ' is-video' : ''
      }${detailSwipeOffset !== 0 || detailSwipeTransition ? ' is-swiping' : ''}`}
      onPointerMoveCapture={overlay.onPointerActivity}
      onPointerLeave={overlay.onPointerActivity}
      onPlayCapture={overlay.show}
      onPointerDownCapture={overlay.onPointerDownCapture}
      onPointerUpCapture={overlay.onPointerUpCapture}
      onPointerCancelCapture={overlay.onPointerCancelCapture}
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
          transform: `translate3d(calc(-100% - var(--file-detail-swipe-gap) + ${detailSwipeOffset}px), 0, 0)`
        }}
      >
        {renderLayer(prevLoadedFile, 'prev', prevSections)}
        {renderLayer(selectedFile, null, { tagGroups, tagSourceSummary })}
        {renderLayer(nextLoadedFile, 'next', nextSections)}
      </div>
      {/* Outside the track: a per-panel control would travel with the swipe,
          and the neighbour's copy would slide in beside it. */}
      <SourcesDialog
        open={sourcesOpen}
        onOpenChange={setSourcesOpen}
        highlights={providerHighlights}
        favoriteSources={favoriteSourceLinks}
        providerMeta={providerMeta}
        nextAutoScanText={nextAutoScanText}
        emptyLabel={
          !providerMeta?.hasRuns
            ? 'No scan results yet.'
            : displayFilterActive
              ? 'No matches for selected sources yet.'
              : 'No high-confidence matches yet.'
        }
        scanBusy={providerState.loading}
        scanError={providerState.error}
        onRunAllProviders={() => void onRunAllProviders()}
      />
      {mediaFullscreen ? fullscreenActions : null}
      {mediaFullscreen ? fullscreenToggle : null}
    </div>
  );
}
