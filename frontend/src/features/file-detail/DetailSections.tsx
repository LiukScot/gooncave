import type { LucideIcon } from 'lucide-react';
import React from 'react';

import type { ProviderHighlight, TagEntry, TagGroup } from './FileDetailPanel';
import { withImpliedTags } from './sections';
import {
  basenameFromPath,
  fileTypeFromPath,
  formatDateTime,
  formatDuration,
  formatSizeMb
} from './utils';

import type { FileItem, RelatedPost } from '@/api';

/**
 * The tag pills and match cards, shared by the detail panel and the swipe
 * preview. The preview passes no handlers and gets the same list without the
 * remove controls; keeping one copy is what stops the two drifting.
 */

/**
 * One of the controls that float on top of the media: the back button, and
 * the vote / delete / favourite row that only fullscreen shows (issue #310).
 * Shared so the gallery's detail view and explore's cannot drift apart.
 */
export function OverlayButton({
  icon: Icon,
  label,
  title,
  onClick,
  className,
  disabled,
  /** Set only for a toggle, where it also drives `aria-pressed`. */
  on,
  danger
}: {
  icon: LucideIcon;
  /** Accessible name. Keep it short and unique on the page. */
  label: string;
  /** Tooltip, when there is more to say than the name. Defaults to it. */
  title?: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  on?: boolean;
  danger?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={[
        'file-detail-overlay-btn',
        className,
        on ? 'is-on' : null,
        danger ? 'is-danger' : null
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      title={title ?? label}
    >
      <Icon className="file-detail-overlay-icon" aria-hidden="true" />
    </button>
  );
}

/**
 * The FILE INFO list. Rendered from the file itself so the panel and the
 * preview cannot end up listing different rows — a row added to one and not
 * the other made the block jump by its own height the moment a swipe landed.
 */
export function FileInfoList({
  file,
  voteSystemEnabled,
  testId
}: {
  file: FileItem;
  voteSystemEnabled: boolean;
  /** Set by the panel only, so tests never match the preview copies. */
  testId?: string;
}): React.ReactElement {
  return (
    <div className="file-detail-info text-muted-foreground text-sm">
      <span className="font-semibold file-detail-label">File name:</span>{' '}
      {basenameFromPath(file.path) || file.path}
      <br />
      {formatDuration(file.durationMs)}
      {file.durationMs ? <br /> : null}
      <span className="font-semibold file-detail-label">Type:</span>{' '}
      {fileTypeFromPath(file.path, file.mediaType)}
      <br />
      <span className="font-semibold file-detail-label">Size:</span>{' '}
      {formatSizeMb(file.sizeBytes)}
      {file.width && file.height ? ` (${file.width}×${file.height})` : ''}
      <br />
      <span className="font-semibold file-detail-label">Modified:</span>{' '}
      {formatDateTime(file.mtime)}
      {voteSystemEnabled ? (
        <>
          <br />
          <span className="font-semibold file-detail-label">Score:</span>{' '}
          <span data-test-id={testId} className="file-detail-vote-score">
            {file.voteScore > 0 ? `+${file.voteScore}` : file.voteScore}
          </span>
        </>
      ) : null}
    </div>
  );
}

export function TagPills({
  groups,
  implied,
  sourceSummary,
  emptyLabel = 'No tags yet.',
  editing = false,
  onRemoveTag,
  onSelectTag
}: {
  groups: readonly TagGroup[];
  /** Tags derived from the stored ones; shown apart and never removable. */
  implied?: readonly string[];
  sourceSummary: string;
  emptyLabel?: string;
  /** Pen mode: every pill grows a remove control. */
  editing?: boolean;
  onRemoveTag?: (entry: TagEntry) => void;
  onSelectTag?: (tag: string) => void;
}): React.ReactElement {
  const shown = implied ? withImpliedTags(groups, implied) : groups;
  return (
    <>
      {shown.length === 0 ? (
        <div className="text-muted-foreground text-sm">{emptyLabel}</div>
      ) : (
        shown.map((group) => (
          <div key={group.category} className="mb-2">
            <div className="text-sm font-semibold uppercase mb-1 file-detail-subtitle">
              {group.category}
            </div>
            <div className="flex flex-wrap gap-2">
              {group.tags.map((tag) => {
                const sources = Array.from(tag.sources).join(', ');
                const scoreText =
                  tag.score !== null ? `score ${tag.score}` : 'score n/a';
                const merged = tag.originals.length > 1;
                const title = tag.implied
                  ? 'Implied by another tag on this file'
                  : merged
                    ? `${tag.originals.join(' + ')} • ${sources} • ${scoreText}`
                    : `${sources} • ${scoreText}`;
                return (
                  <span
                    key={`${group.category}-${tag.tag}`}
                    className="badge bg-secondary text-foreground file-tag-pill"
                    title={title}
                  >
                    {editing && onRemoveTag && !tag.implied ? (
                      <button
                        className="btn btn-link btn-sm p-0 mr-2 text-foreground file-tag-remove"
                        type="button"
                        onClick={() => onRemoveTag(tag)}
                        aria-label={`Remove ${tag.tag}`}
                      >
                        ×
                      </button>
                    ) : null}
                    {onSelectTag && !editing ? (
                      <button
                        className="btn btn-link btn-sm p-0 text-foreground file-tag-select"
                        type="button"
                        onClick={() => onSelectTag(tag.tag)}
                      >
                        {tag.tag}
                      </button>
                    ) : (
                      tag.tag
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        ))
      )}
      <div className="text-muted-foreground text-sm mt-2">
        <span className="file-detail-label">Sources:</span> {sourceSummary}
      </div>
    </>
  );
}

export function SauceCards({
  highlights,
  emptyLabel,
  removeDisabled,
  onRemoveTopMatch
}: {
  highlights: readonly ProviderHighlight[];
  emptyLabel: string;
  removeDisabled?: boolean;
  onRemoveTopMatch?: (sourceUrl: string) => void;
}): React.ReactElement {
  if (highlights.length === 0) {
    return (
      <div className="file-detail-topmatches-empty text-muted-foreground text-sm">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="file-detail-topmatches-list">
      {highlights.map((item) => (
        // The card is the positioned wrapper, not the link: a <button> inside
        // an <a> is invalid HTML and assistive tech exposes it inconsistently.
        <div
          key={item.id}
          className="file-detail-topmatches-card border border-secondary rounded p-2 bg-background text-foreground"
        >
          <a
            className="text-decoration-none text-foreground"
            href={item.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            <div className="text-muted-foreground text-sm">{item.provider}</div>
            <div className="font-semibold truncate" title={item.sourceName}>
              {item.sourceName}
            </div>
            <div className="text-muted-foreground text-sm">
              {item.score !== null ? `score ${item.score}` : 'score n/a'}
            </div>
          </a>
          {onRemoveTopMatch ? (
            <button
              type="button"
              className="file-detail-topmatches-remove"
              onClick={() => onRemoveTopMatch(item.sourceUrl)}
              disabled={removeDisabled}
              aria-label={`Remove ${item.sourceName}`}
            >
              ×
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * The parent/child group of the open post, as a strip of thumbnails: the
 * parent first, then its children, with the post already on screen marked.
 *
 * Nothing is rendered when the post stands alone, so the section never shows
 * an empty box on the many files that have no relatives.
 */
export function RelatedPostsSection({
  posts,
  loading,
  expected,
  onOpen
}: {
  posts: readonly RelatedPost[];
  /** The booru is still answering. */
  loading: boolean;
  /**
   * Whether relatives are known to exist before the answer arrives — the
   * grid already knows, so the strip can hold its place instead of appearing
   * under the reader's eyes and pushing the tags down.
   */
  expected: boolean;
  /** Opens one inside GoonCave: the library file, or the post in explore. */
  onOpen: (post: RelatedPost) => void;
}): React.ReactElement | null {
  const pending = loading && expected && posts.length === 0;
  if (!posts.length && !pending) return null;
  return (
    <>
      <div className="file-detail-section-divider" />
      <div className="file-detail-section mb-4">
        <div className="file-detail-section-head">
          <div className="uppercase font-semibold file-detail-section-title">
            Related posts
          </div>
        </div>
        <div className="file-detail-relations" data-test-id="related-posts">
          {pending
            ? [0, 1].map((slot) => (
                <span
                  key={slot}
                  className="file-detail-relation is-pending"
                  aria-hidden="true"
                />
              ))
            : posts.map((post) => (
                <button
                  type="button"
                  key={post.remoteId}
                  className={`file-detail-relation${post.isCurrent ? ' is-current' : ''}`}
                  onClick={() => onOpen(post)}
                  disabled={post.isCurrent}
                  // Colour alone would not say which one is open, and the
                  // label below is the only one a screen reader gets.
                  aria-current={post.isCurrent ? 'true' : undefined}
                  title={
                    post.isCurrent
                      ? `Post ${post.remoteId} — the one you are looking at`
                      : post.localFileId
                        ? `Open post ${post.remoteId} in your library`
                        : `Open post ${post.remoteId} in explore`
                  }
                >
                  {post.previewUrl ?? post.sampleUrl ? (
                    <img
                      src={post.previewUrl ?? post.sampleUrl ?? undefined}
                      alt={`Post ${post.remoteId}`}
                      loading="lazy"
                      decoding="async"
                      // danbooru's CDN answers 403 without a Referer;
                      // `origin` sends the host and never the path.
                      referrerPolicy="origin"
                    />
                  ) : (
                    <span className="file-detail-relation-blank">
                      no preview
                    </span>
                  )}
                  <span className="file-detail-relation-label">
                    {post.isParent ? 'parent' : `#${post.remoteId}`}
                  </span>
                </button>
              ))}
        </div>
      </div>
    </>
  );
}
