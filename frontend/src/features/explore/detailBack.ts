/**
 * Where back leads from an open Explore post. The close button and the swipe from the left edge
 * both ask this, so the two cannot send the reader to different places.
 *
 * - `pool`: the pool the post was read in, which is not the entry before it.
 * - `excursion`: the screen an excursion (a related post, a post opened over the Gallery) came
 *   from; with `byHistory` that screen is the entry before, so back is one plain history step.
 * - `pushed`: the results, one history entry back.
 * - `grid`: the results, in this same entry, as after a post opened from its link.
 */
export type DetailBack =
  | { to: 'pool' }
  | { to: 'excursion'; byHistory: boolean }
  | { to: 'pushed' }
  | { to: 'grid' };

export const detailBack = ({
  inPool,
  excursion,
  entryPushed
}: {
  inPool: boolean;
  excursion: { returnsByBack?: boolean } | null;
  entryPushed: boolean;
}): DetailBack => {
  if (inPool) return { to: 'pool' };
  if (excursion) return { to: 'excursion', byHistory: excursion.returnsByBack === true };
  return entryPushed ? { to: 'pushed' } : { to: 'grid' };
};
