import { ExternalLink, Heart } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { displayUrlFor, isVideoUrl } from './exploreMedia';
import { ratingLabel } from './rating';

import type { ExplorePost } from '@/api';
import { TagPills } from '@/features/file-detail/DetailSections';
import type {
  TagEntry,
  TagGroup
} from '@/features/file-detail/FileDetailPanel';
import {
  useBodyScrollLock,
  useDetailSwipe
} from '@/features/file-detail/useDetailSwipe';
import { useMediaZoom } from '@/features/file-detail/useMediaZoom';
import {
  rewindVideoBeforeEnd,
  restartVideoLoop,
  togglePlayback
} from '@/features/file-detail/videoLoop';
import {
  readVideoSound,
  writeVideoSound
} from '@/features/file-detail/videoVolume';
import { VoteControl } from '@/features/file-detail/VoteControl';
import {
  actionForKey,
  isBindableEvent,
  withShortcutHint
} from '@/features/shortcuts/shortcuts';
import { useShortcuts } from '@/features/shortcuts/useShortcuts';
import { formatDateTime } from '@/lib/format';

const formatBytes = (bytes: number | null): string => {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
};

/**
 * A remote post in the shape of the gallery's file detail: same frame, same
 * zoomable media, same fullscreen toggle, same neighbour arrows, same
 * sections in the same order, same keys.
 *
 * What differs is only what a remote post can offer. There is no file to
 * delete and no sauce to look up, so that section carries the post's origin
 * instead, and the vote goes to the booru rather than the local database.
 */
export function ExploreDetailPanel({
  post,
  prevPost,
  nextPost,
  supportsVote,
  canVote,
  canFavorite,
  favorited,
  voted,
  voteBusy,
  favoriteBusy,
  actionError,
  hasPrev,
  hasNext,
  onGoRelative,
  onClose,
  onVote,
  onFavorite,
  onSelectTag
}: {
  post: ExplorePost;
  /** The neighbours, so a swipe slides in a picture rather than a blank. */
  prevPost: ExplorePost | null;
  nextPost: ExplorePost | null;
  /** The booru has a vote API. */
  supportsVote: boolean;
  /** …and this account has the credentials to use it. */
  canVote: boolean;
  /** The booru takes favorites and this account can send one. */
  canFavorite: boolean;
  favorited: boolean;
  voted: 1 | -1 | null;
  voteBusy: boolean;
  /** Favoriting downloads the file, so it owns its own wait. */
  favoriteBusy: boolean;
  actionError: string | null;
  hasPrev: boolean;
  hasNext: boolean;
  onGoRelative: (delta: number) => void;
  onClose: () => void;
  onVote: (score: 1 | -1) => void;
  onFavorite: () => void;
  onSelectTag: (tag: string) => void;
}): React.ReactElement {
  const shortcuts = useShortcuts();
  const [mediaFullscreen, setMediaFullscreen] = useState(false);
  const currentVideoRef = useRef<HTMLVideoElement | null>(null);
  const postKey = `${post.siteId}:${post.remoteId}`;
  const zoom = useMediaZoom(mediaFullscreen, postKey);
  // Same gesture as the gallery: the neighbour arrives on a swipe, and the
  // page underneath stays put while one is in flight.
  const swipe = useDetailSwipe({
    open: true,
    itemKey: postKey,
    canPrev: Boolean(prevPost),
    canNext: Boolean(nextPost),
    onCommit: onGoRelative
  });
  useBodyScrollLock(mediaFullscreen || swipe.locked);
  const mediaUrl = displayUrlFor(post);
  const isVideo = isVideoUrl(post.fileUrl);

  // The same keys the gallery detail binds, read from the same user
  // bindings: Esc leaves fullscreen first and only then the post, so one
  // press never does both.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!isBindableEvent(event)) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      ) {
        return;
      }
      const action = actionForKey(shortcuts, 'detail', event.key);
      if (!action) return;
      if (action === 'playPause') {
        // Swallowed only when there was a video to toggle: on a picture the
        // space bar must still scroll the panel.
        if (togglePlayback(currentVideoRef.current)) event.preventDefault();
        return;
      }
      if (action === 'prev') {
        event.preventDefault();
        onGoRelative(-1);
      } else if (action === 'next') {
        event.preventDefault();
        onGoRelative(1);
      } else if (action === 'close') {
        event.preventDefault();
        if (mediaFullscreen) setMediaFullscreen(false);
        else onClose();
      } else if (action === 'fullscreen') {
        event.preventDefault();
        setMediaFullscreen((current) => !current);
      } else if (action === 'voteUp' && canVote) {
        event.preventDefault();
        onVote(1);
      } else if (action === 'voteDown' && canVote) {
        event.preventDefault();
        onVote(-1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [shortcuts, mediaFullscreen, onClose, onGoRelative, onVote, canVote]);

  // Grouped by the category the booru filed each tag under, exactly as the
  // gallery groups a local file's tags — which also stops the section header
  // and a single "tags" subheading from saying the same word twice.
  const tagGroups: TagGroup[] = useMemo(() => {
    const byCategory = new Map<string, TagEntry[]>();
    for (const { tag, category } of post.tags) {
      const entries = byCategory.get(category) ?? [];
      entries.push({
        tag,
        originals: [tag],
        category,
        sources: new Set([post.siteName]),
        score: null
      });
      byCategory.set(category, entries);
    }
    return Array.from(byCategory, ([category, tags]) => ({ category, tags }));
  }, [post.tags, post.siteName]);

  // A disabled control with a cheerful "Vote up" tooltip reads as broken, so
  // the buttons carry the reason instead of the shortcut they cannot fire.
  const voteHint = (label: string, binding: string) =>
    canVote
      ? withShortcutHint(label, binding)
      : `Add an API key for ${post.siteName} under Settings → Favorites accounts to vote`;

  const infoRows: [string, React.ReactNode][] = [
    ['Site', post.siteName],
    [
      'Post',
      <a
        key="post-link"
        href={post.sourceUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="btn btn-link btn-sm p-0 align-baseline"
      >
        #{post.remoteId}
      </a>
    ],
    ...(post.uploader
      ? ([['Uploader', post.uploader]] as [string, React.ReactNode][])
      : []),
    ...(post.createdAt
      ? ([['Posted', formatDateTime(post.createdAt)]] as [
          string,
          React.ReactNode
        ][])
      : []),
    ...(post.rating
      ? ([['Rating', ratingLabel(post.rating, post.engine)]] as [
          string,
          React.ReactNode
        ][])
      : []),
    ...(post.score !== null
      ? ([['Score', String(post.score)]] as [string, React.ReactNode][])
      : []),
    ...(post.favCount !== null
      ? ([['Favorites', String(post.favCount)]] as [string, React.ReactNode][])
      : []),
    ...(post.width && post.height
      ? ([['Size', `${post.width}×${post.height}`]] as [
          string,
          React.ReactNode
        ][])
      : []),
    ...(post.fileExt || post.fileSize
      ? ([
          [
            'Type',
            [post.fileExt?.toUpperCase(), formatBytes(post.fileSize)]
              .filter(Boolean)
              .join(' · ')
          ]
        ] as [string, React.ReactNode][])
      : []),
    ['Tags', String(post.tags.length)]
  ];

  const fullscreenToggle = (
    <button
      className="file-detail-fullscreen-btn"
      onClick={() => setMediaFullscreen((current) => !current)}
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
      ref={swipe.frameRef}
      className={`file-detail-frame${mediaFullscreen ? ' is-fullscreen' : ''}${
        isVideo ? ' is-video' : ''
      }`}
      onTouchStart={swipe.onTouchStart}
      onTouchEnd={swipe.onTouchEnd}
      onTouchCancel={swipe.onTouchEnd}
    >
      <div
        className={`file-detail-track${swipe.transitioning ? ' is-transitioning' : ''}`}
        style={{
          transform: `translate3d(calc(-100% + ${swipe.offset}px), 0, 0)`
        }}
      >
        <NeighbourPanel post={prevPost} direction="prev" />
        <div
          className={`file-detail-panel file-detail-panel-current file-detail-layer text-foreground${
            isVideo ? ' is-video' : ''
          }`}
        >
          <div
            ref={zoom.wrapRef}
            className={`file-detail-media-wrap${mediaFullscreen ? ' is-fullscreen' : ''}${
              zoom.zoomed ? ' is-zoomed' : ''
            }`}
            {...zoom.handlers}
            onDoubleClick={zoom.reset}
            style={
              {
                '--file-detail-zoom': zoom.transform ?? 'none',
                '--file-detail-poster': post.previewUrl
                  ? `url("${encodeURI(post.previewUrl)}")`
                  : 'none',
                '--file-detail-aspect':
                  post.width && post.height
                    ? `${post.width} / ${post.height}`
                    : '4 / 3'
              } as React.CSSProperties
            }
            onClick={(event) => {
              if (
                mediaFullscreen &&
                !zoom.zoomed &&
                event.target === event.currentTarget
              ) {
                setMediaFullscreen(false);
              }
            }}
          >
            <button
              className="file-detail-nav file-detail-nav-left"
              onClick={() => onGoRelative(-1)}
              disabled={!hasPrev}
              aria-label="Previous"
              title={withShortcutHint('Previous post', shortcuts.prev)}
            >
              ‹
            </button>
            <button
              className="file-detail-nav file-detail-nav-right"
              onClick={() => onGoRelative(1)}
              disabled={!hasNext}
              aria-label="Next"
              title={withShortcutHint('Next post', shortcuts.next)}
            >
              ›
            </button>
            {mediaUrl === null ? (
              <div className="text-muted-foreground text-sm p-4">
                This post has no viewable media.
              </div>
            ) : isVideo ? (
              // Keyed by post so React remounts rather than swapping src on a
              // playing element, which would keep the previous frame up.
              <video
                key={postKey}
                src={mediaUrl}
                className="file-detail-media"
                controls
                playsInline
                preload="metadata"
                poster={post.previewUrl ?? undefined}
                // `volume` is a DOM property, not an attribute, so React
                // cannot set it declaratively. Shared with the gallery
                // player, so a level set on either carries to the other.
                ref={(element) => {
                  currentVideoRef.current = element;
                  if (!element) return;
                  const sound = readVideoSound();
                  element.volume = sound.volume;
                  element.muted = sound.muted;
                }}
                onVolumeChange={(event) => {
                  const { volume, muted } = event.currentTarget;
                  writeVideoSound({ volume, muted });
                }}
                onTimeUpdate={(event) =>
                  rewindVideoBeforeEnd(event.currentTarget)
                }
                onEnded={(event) => restartVideoLoop(event.currentTarget)}
              />
            ) : (
              <img
                key={postKey}
                src={mediaUrl}
                alt={`Post ${post.remoteId} on ${post.siteName}`}
                className="file-detail-media"
                referrerPolicy="origin"
              />
            )}
            {mediaFullscreen ? null : fullscreenToggle}
          </div>

          <div className="container file-detail-body">
            <div className="file-detail-section mb-4">
              <div className="file-detail-section-head">
                <div className="uppercase font-semibold file-detail-section-title">
                  Info
                </div>
                <div className="file-detail-section-actions">
                  <a
                    className="btn btn-outline-light btn-sm file-detail-icon-button"
                    href={post.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label={`Open on ${post.siteName}`}
                    title={`Open on ${post.siteName}`}
                  >
                    <ExternalLink className="size-4" aria-hidden="true" />
                  </a>
                  {supportsVote ? (
                    <VoteControl
                      voteScore={post.score ?? 0}
                      cooldownText={null}
                      busy={voteBusy || !canVote}
                      onVote={onVote}
                      voted={voted}
                      upHint={voteHint(
                        voted === 1 ? 'Voted up' : 'Vote up',
                        shortcuts.voteUp
                      )}
                      downHint={voteHint(
                        voted === -1 ? 'Voted down' : 'Vote down',
                        shortcuts.voteDown
                      )}
                    />
                  ) : null}
                  <button
                    className={`btn btn-sm file-detail-icon-button ${
                      favorited ? 'btn-primary' : 'btn-outline-light'
                    }`}
                    disabled={
                      favoriteBusy ||
                      (!favorited && !post.fileUrl) ||
                      !canFavorite
                    }
                    onClick={onFavorite}
                    aria-label={
                      favorited ? 'Remove from favorites' : 'Favorite and save'
                    }
                    title={
                      !canFavorite
                        ? `Add an API key for ${post.siteName} under Settings → Favorites accounts to favorite`
                        : favorited
                          ? 'Remove from favorites and delete the saved copy'
                          : post.fileUrl
                            ? 'Favorite and save to your library now'
                            : 'This post has no downloadable file'
                    }
                  >
                    <Heart
                      className="size-4"
                      aria-hidden="true"
                      fill={favorited ? 'currentColor' : 'none'}
                    />
                  </button>
                </div>
              </div>
              {/* The rows e621 puts on a post page, minus the ones no other
                  booru reports. A row whose engine sends nothing is dropped
                  rather than printed as "unknown". */}
              <div className="file-detail-info text-muted-foreground text-sm">
                {infoRows.map(([label, value]) => (
                  <React.Fragment key={label}>
                    <span className="font-semibold file-detail-label">
                      {label}:
                    </span>{' '}
                    {value}
                    <br />
                  </React.Fragment>
                ))}
              </div>
              {actionError ? (
                <div className="text-destructive text-sm mt-2">
                  {actionError}
                </div>
              ) : null}
            </div>

            <div className="file-detail-section-divider" />

            <div className="file-detail-tags file-detail-section mb-4">
              <div className="file-detail-section-head">
                <div className="uppercase font-semibold file-detail-section-title">
                  Tags
                </div>
              </div>
              <TagPills
                groups={tagGroups}
                sourceSummary={post.siteName}
                emptyLabel="This post carries no tags."
                onSelectTag={onSelectTag}
              />
            </div>
          </div>
        </div>
        <NeighbourPanel post={nextPost} direction="next" />
      </div>
      {/* Outside the media wrap: in fullscreen the picture covers the screen,
          and a button nested in it would be the thing the exit tap has to
          miss. Esc is the only other way out, and a phone has no Esc. */}
      {mediaFullscreen ? fullscreenToggle : null}
    </div>
  );
}

/**
 * The picture a swipe is heading towards. Only the thumbnail: the panel is
 * decorative, off-screen until the gesture starts, and pulling three full
 * files per open post is what the gallery already refuses to do.
 */
function NeighbourPanel({
  post,
  direction
}: {
  post: ExplorePost | null;
  direction: 'prev' | 'next';
}): React.ReactElement {
  return (
    <div
      className={`file-detail-panel file-detail-panel-preview file-detail-panel-${direction}`}
      aria-hidden="true"
    >
      {post?.previewUrl ? (
        <div
          className="file-detail-preview-shell file-detail-layer"
          style={
            {
              '--file-detail-aspect':
                post.width && post.height
                  ? `${post.width} / ${post.height}`
                  : '4 / 3'
            } as React.CSSProperties
          }
        >
          <div className="file-detail-media-wrap file-detail-media-wrap-preview">
            <img
              src={post.previewUrl}
              alt=""
              className="file-detail-media"
              decoding="async"
              referrerPolicy="origin"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
