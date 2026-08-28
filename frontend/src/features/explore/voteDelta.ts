/**
 * How much a post's score moves when the user votes, given the vote they
 * already had on it.
 *
 * The booru owns the real number, and re-fetching a post just to read it back
 * costs a request per click. Applying the delta locally keeps the score
 * honest for every transition the UI allows: switching sides moves two
 * points, since the previous vote is withdrawn and the opposite one counted.
 *
 * Voting the same way twice is not an unvote — the engines are called with
 * no-unvote semantics — so the score stays put.
 */
export const voteDelta = (previous: 1 | -1 | null, next: 1 | -1): number => {
  if (previous === next) return 0;
  return previous === null ? next : next * 2;
};
