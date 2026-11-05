import { ChevronDown, ChevronUp, Share2 } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { OverlayButton } from '@/features/file-detail/DetailSections';
import { ClosesPanel, MoreActionsPanel } from '@/features/file-detail/MoreActionsPanel';
import { useAppearanceStore } from '@/stores/appearanceStore';

/**
 * Favoriting, voting and sharing on an open Explore post: the one chosen in
 * Settings → Appearance sits in the corner, the others in the panel. A choice
 * closes the panel, back to the post.
 */
export function PostMoreMenu({
  favorite,
  shareTitle,
  onShare,
  vote
}: {
  favorite: ReactNode;
  shareTitle: string;
  onShare: () => void;
  /** Absent on a site without votes. */
  vote?: {
    voted: number | null;
    /** The post's score on its site, when the site gives one. */
    score: number | null;
    disabled: boolean;
    upTitle: string;
    downTitle: string;
    onVote: (value: 1 | -1) => void;
  };
}) {
  const [open, setOpen] = useState(false);
  const quick = useAppearanceStore((state) => state.quickActions.post);
  const close = () => setOpen(false);
  const voteButtons = vote ? (
    <div className="file-detail-overlay-group" role="group" aria-label="Vote">
      <OverlayButton
        icon={ChevronUp}
        on={vote.voted === 1}
        label="Vote up"
        title={vote.upTitle}
        note={vote.score === null ? undefined : `Score ${vote.score}`}
        disabled={vote.disabled}
        onClick={() => {
          close();
          vote.onVote(1);
        }}
      />
      <OverlayButton
        icon={ChevronDown}
        on={vote.voted === -1}
        label="Vote down"
        title={vote.downTitle}
        disabled={vote.disabled}
        onClick={() => {
          close();
          vote.onVote(-1);
        }}
      />
    </div>
  ) : null;
  return (
    <>
      {quick === 'favorite' ? favorite : null}
      {quick === 'vote' ? voteButtons : null}
      {quick === 'share' ? (
        <OverlayButton icon={Share2} label="Share" title={shareTitle} onClick={onShare} />
      ) : null}
      <MoreActionsPanel open={open} setOpen={setOpen} title="Actions for this post">
        {quick === 'favorite' ? null : <ClosesPanel close={close} shrink={4}>{favorite}</ClosesPanel>}
        {quick === 'vote' || !voteButtons ? null : (
          <div className="contents" data-shrink={3}>
            {voteButtons}
          </div>
        )}
        {quick === 'share' ? null : (
          <button
            type="button"
            className="btn btn-outline-light panel-pill"
            title={shareTitle}
            aria-label="Share"
            data-shrink={2}
            onClick={() => {
              close();
              onShare();
            }}
          >
            <Share2 aria-hidden="true" />
            <span className="panel-pill-text" aria-hidden="true">Share</span>
          </button>
        )}
      </MoreActionsPanel>
    </>
  );
}
