import type { LucideIcon } from 'lucide-react';
import React, { useState } from 'react';

import type { ProviderHighlight, TagEntry, TagGroup } from './FileDetailPanel';
import {
  basenameFromPath,
  fileTypeFromPath,
  formatDateTime,
  formatDuration,
  formatSizeMb
} from './utils';

import type { FileItem } from '@/api';

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
  return (
    <>
      {groups.length === 0 ? (
        <div className="text-muted-foreground text-sm">{emptyLabel}</div>
      ) : (
        groups.map((group) => (
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
                const title = merged
                  ? `${tag.originals.join(' + ')} • ${sources} • ${scoreText}`
                  : `${sources} • ${scoreText}`;
                return (
                  <span
                    key={`${group.category}-${tag.tag}`}
                    className="badge bg-secondary text-foreground file-tag-pill"
                    title={title}
                  >
                    {editing && onRemoveTag ? (
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
                    {/* A merged pill says so on its face: clicking × on it
                        removes every original behind it, and a bare name
                        would give no warning of that. */}
                    {merged ? (
                      <span className="file-tag-count">
                        ·{tag.originals.length}
                      </span>
                    ) : null}
                  </span>
                );
              })}
            </div>
          </div>
        ))
      )}
      {implied && implied.length > 0 ? (
        <ImpliedTags tags={implied} onSelectTag={onSelectTag} />
      ) : null}
      <div className="text-muted-foreground text-sm mt-2">
        <span className="file-detail-label">Sources:</span> {sourceSummary}
      </div>
    </>
  );
}

/**
 * Implied tags fold away by default: a file averages a dozen of them, which
 * is enough to bury the tags a provider actually asserted on a phone.
 */
function ImpliedTags({
  tags,
  onSelectTag
}: {
  tags: readonly string[];
  onSelectTag?: (tag: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2 file-tag-implied">
      <button
        className="btn btn-link btn-sm p-0 text-sm font-semibold uppercase file-detail-subtitle"
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} Implied ({tags.length})
      </button>
      {open ? (
        <div className="flex flex-wrap gap-2 mt-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="badge bg-secondary text-foreground file-tag-pill is-implied"
              title="Implied by another tag on this file"
            >
              {onSelectTag ? (
                <button
                  className="btn btn-link btn-sm p-0 text-foreground file-tag-select"
                  type="button"
                  onClick={() => onSelectTag(tag)}
                >
                  {tag}
                </button>
              ) : (
                tag
              )}
            </span>
          ))}
        </div>
      ) : null}
    </div>
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
