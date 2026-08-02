import { create } from 'zustand';

import type { GallerySort } from '@/features/library/GalleryView';

const gallerySortStorageKey = 'imagesearch.gallerySort';

const makeRandomSeed = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const isGallerySort = (value: string | null): value is GallerySort =>
  value === 'manual' ||
  value === 'mtime_desc' ||
  value === 'mtime_asc' ||
  value === 'random';

const resolveInitialSort = (): GallerySort => {
  if (typeof window === 'undefined') return 'mtime_desc';
  const stored = window.localStorage.getItem(gallerySortStorageKey);
  return isGallerySort(stored) ? stored : 'mtime_desc';
};

type GalleryFilters = {
  photos: boolean;
  videos: boolean;
  starred: boolean;
};

type GalleryUiStore = {
  galleryFolderId: string;
  gallerySort: GallerySort;
  galleryFilters: GalleryFilters;
  isGalleryFilterOpen: boolean;
  galleryRandomSeed: string;
  galleryTagInput: string;
  galleryTagQuery: string;
  setGalleryFolderId: (folderId: string) => void;
  setGallerySort: (sort: GallerySort) => void;
  setGalleryFilters: (
    update: GalleryFilters | ((prev: GalleryFilters) => GalleryFilters)
  ) => void;
  setIsGalleryFilterOpen: (
    open: boolean | ((prev: boolean) => boolean)
  ) => void;
  setGalleryRandomSeed: (seed: string) => void;
  setGalleryTagInput: (value: string) => void;
  setGalleryTagQuery: (value: string) => void;
  resetGalleryUiState: () => void;
};

export const useGalleryUiStore = create<GalleryUiStore>((set) => ({
  galleryFolderId: '',
  gallerySort: resolveInitialSort(),
  galleryFilters: {
    photos: false,
    videos: false,
    starred: false
  },
  isGalleryFilterOpen: false,
  galleryRandomSeed: makeRandomSeed(),
  galleryTagInput: '',
  galleryTagQuery: '',
  setGalleryFolderId: (galleryFolderId) => set({ galleryFolderId }),
  setGallerySort: (gallerySort) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(gallerySortStorageKey, gallerySort);
    }
    set({ gallerySort });
  },
  setGalleryFilters: (update) =>
    set((state) => ({
      galleryFilters:
        typeof update === 'function' ? update(state.galleryFilters) : update
    })),
  setIsGalleryFilterOpen: (update) =>
    set((state) => ({
      isGalleryFilterOpen:
        typeof update === 'function'
          ? update(state.isGalleryFilterOpen)
          : update
    })),
  setGalleryRandomSeed: (galleryRandomSeed) => set({ galleryRandomSeed }),
  setGalleryTagInput: (galleryTagInput) => set({ galleryTagInput }),
  setGalleryTagQuery: (galleryTagQuery) => set({ galleryTagQuery }),
  resetGalleryUiState: () =>
    set((state) => ({
      galleryFolderId: '',
      galleryFilters: {
        photos: false,
        videos: false,
        starred: false
      },
      isGalleryFilterOpen: false,
      galleryRandomSeed: makeRandomSeed(),
      galleryTagInput: '',
      galleryTagQuery: '',
      gallerySort: state.gallerySort
    }))
}));

export { makeRandomSeed };
