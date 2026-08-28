import { create } from 'zustand';

/**
 * What the app header needs to drive an open explore post: the same Back and
 * Prev/Next controls the gallery gets. Those buttons live in the shell, above
 * the routed view, so the explore controller publishes its navigation here
 * rather than the shell reaching down into a view it does not own.
 *
 * Null means no post is open and the header shows the plain navigation.
 */
export type ExploreDetailNav = {
  hasPrev: boolean;
  hasNext: boolean;
  goRelative: (delta: number) => void;
  close: () => void;
};

type ExploreUiStore = {
  detailNav: ExploreDetailNav | null;
  setDetailNav: (nav: ExploreDetailNav | null) => void;
};

export const useExploreUiStore = create<ExploreUiStore>((set) => ({
  detailNav: null,
  setDetailNav: (detailNav) => set({ detailNav })
}));
