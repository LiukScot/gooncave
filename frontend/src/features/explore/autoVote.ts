/**
 * Whether favoriting a post should also cast an upvote.
 *
 * Boorus treat the two as separate actions, and on the ones that have voting
 * a favorite without a vote is half the signal the user meant to send. A post
 * already voted up is left alone: the engines are called with no-unvote
 * semantics, so re-sending the same vote is at best a wasted request.
 */
export const shouldAutoVote = (
  enabled: boolean,
  canVote: boolean,
  currentVote: 1 | -1 | null
): boolean => enabled && canVote && currentVote !== 1;
