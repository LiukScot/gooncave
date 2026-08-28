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
  /** Tooltips carrying the bound key; the preview passes neither. */
  upHint?: string;
  downHint?: string;
  /**
   * The vote already cast, which tints that button — green up, red down.
   * Only explore passes it: a remote booru keeps the vote on the account,
   * so the button is the only place the user can see what they chose. The
   * gallery's own votes are shown by its score and undo capsule instead.
   */
  voted?: 1 | -1 | null;
};

export function VoteControl({
  voteScore,
  cooldownText,
  busy,
  onVote,
  upHint,
  downHint,
  voted
}: Props): React.ReactElement {
  const inert = !onVote;
  const buttonClass = `btn btn-outline-light btn-sm file-detail-icon-button${
    inert ? ' file-detail-preview-control' : ''
  }`;
  const upClass = `${buttonClass}${voted === 1 ? ' file-detail-vote-up' : ''}`;
  const downClass = `${buttonClass}${
    voted === -1 ? ' file-detail-vote-down' : ''
  }`;

  return (
    <div
      // A cooldown is a status, not a control, so the block drops the
      // button-group chrome along with the buttons it no longer holds.
      className={`file-detail-vote${cooldownText ? '' : ' btn-group btn-group-sm'}`}
      role={inert ? undefined : 'group'}
      aria-label={inert ? undefined : 'Vote'}
      aria-hidden={inert || undefined}
    >
      {cooldownText ? (
        <span
          className="file-detail-vote-cooldown"
          title={inert ? undefined : `Votable again in ${cooldownText}`}
        >
          <Clock className="file-detail-vote-icon" aria-hidden="true" />
          {cooldownText}
        </span>
      ) : (
        <>
          <button
            type="button"
            className={upClass}
            disabled={busy}
            tabIndex={inert ? -1 : undefined}
            aria-pressed={voted === undefined ? undefined : voted === 1}
            onClick={onVote && (() => onVote(1))}
            aria-label={inert ? undefined : 'Vote up'}
            title={inert ? undefined : (upHint ?? 'Vote up')}
          >
            <ChevronUp className="file-detail-vote-icon" aria-hidden="true" />
          </button>
          {/* A local score never goes below zero, so at zero there is
              nothing to vote down. Remote posts can sit at zero and still
              take a downvote, and they pass `voted` — so the button stays. */}
          {voteScore > 0 || voted !== undefined ? (
            <button
              type="button"
              className={downClass}
              disabled={busy}
              tabIndex={inert ? -1 : undefined}
              aria-pressed={voted === undefined ? undefined : voted === -1}
              onClick={onVote && (() => onVote(-1))}
              aria-label={inert ? undefined : 'Vote down'}
              title={inert ? undefined : (downHint ?? 'Vote down')}
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
