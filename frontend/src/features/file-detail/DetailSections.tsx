import React from 'react';

import type { ProviderHighlight, TagGroup } from './FileDetailPanel';

/**
 * The tag pills and match cards, shared by the detail panel and the swipe
 * preview. The preview passes no handlers and gets the same list without the
 * remove controls; keeping one copy is what stops the two drifting.
 */

export function TagPills({
  groups,
  sourceSummary,
  emptyLabel = 'No tags yet.',
  onRemoveManualTag
}: {
  groups: readonly TagGroup[];
  sourceSummary: string;
  emptyLabel?: string;
  onRemoveManualTag?: (tag: string, category: string) => void;
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
                return (
                  <span
                    key={`${group.category}-${tag.tag}`}
                    className="badge bg-secondary text-foreground file-tag-pill"
                    title={`${sources} • ${scoreText}`}
                  >
                    {tag.tag}
                    {tag.hasManual && onRemoveManualTag ? (
                      <button
                        className="btn btn-link btn-sm p-0 ml-2 text-foreground file-tag-remove"
                        onClick={() =>
                          onRemoveManualTag(tag.tag, group.category)
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
    return <div className="text-muted-foreground text-sm">{emptyLabel}</div>;
  }
  return (
    <div className="file-detail-topmatches-list">
      {highlights.map((item) => (
        <a
          key={item.id}
          className="file-detail-topmatches-card text-decoration-none border border-secondary rounded p-2 bg-background text-foreground"
          href={item.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          {onRemoveTopMatch ? (
            <button
              type="button"
              className="file-detail-topmatches-remove"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRemoveTopMatch(item.sourceUrl);
              }}
              disabled={removeDisabled}
              aria-label={`Remove ${item.sourceName}`}
            >
              ×
            </button>
          ) : null}
          <div className="text-muted-foreground text-sm">{item.provider}</div>
          <div className="font-semibold truncate" title={item.sourceName}>
            {item.sourceName}
          </div>
          <div className="text-muted-foreground text-sm">
            {item.score !== null ? `score ${item.score}` : 'score n/a'}
          </div>
        </a>
      ))}
    </div>
  );
}
