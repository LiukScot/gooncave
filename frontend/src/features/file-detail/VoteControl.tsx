import { ChevronDown, ChevronUp, Clock } from 'lucide-react';
import React from 'react';

type Props = {
  voteScore: number;
  /** Hours left on the cooldown; the block collapses to a clock while set. */
  cooldownText: string | null;
  busy?: boolean;
  /**
   * Omitted by the swipe preview, which renders an inert ghost of the panel.
   * Sharing the markup is the point: the preview used to carry its own copy
   * and silently kept rendering the previous design after the panel changed.
   */
  onVote?: (value: 1 | -1) => void;
};

export function VoteControl({
  voteScore,
  cooldownText,
  busy,
  onVote
}: Props): React.ReactElement {
  const inert = !onVote;
  const buttonClass = `btn btn-outline-light btn-sm file-detail-icon-button${
    inert ? ' file-detail-preview-control' : ''
  }`;

  return (
    <div
      className="btn-group btn-group-sm file-detail-vote"
      role={inert ? undefined : 'group'}
      aria-label={inert ? undefined : 'Vote'}
      aria-hidden={inert || undefined}
    >
      {cooldownText ? (
        <button
          type="button"
          className={`${buttonClass} file-detail-vote-cooldown`}
          disabled
          tabIndex={inert ? -1 : undefined}
          title={inert ? undefined : `Votable again in ${cooldownText}`}
        >
          <Clock className="file-detail-vote-icon" aria-hidden="true" />
          {cooldownText}
        </button>
      ) : (
        <>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            tabIndex={inert ? -1 : undefined}
            onClick={onVote && (() => onVote(1))}
            aria-label={inert ? undefined : 'Vote up'}
            title={inert ? undefined : 'Vote up'}
          >
            <ChevronUp className="file-detail-vote-icon" aria-hidden="true" />
          </button>
          {/* A score never goes below zero, so at zero there is nothing to
              vote down. */}
          {voteScore > 0 ? (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              tabIndex={inert ? -1 : undefined}
              onClick={onVote && (() => onVote(-1))}
              aria-label={inert ? undefined : 'Vote down'}
              title={inert ? undefined : 'Vote down'}
            >
              <ChevronDown
                className="file-detail-vote-icon"
                aria-hidden="true"
              />
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
