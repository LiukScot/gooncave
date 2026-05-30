import { create } from 'zustand';

import type { DuplicateScanOptions } from '@/api';

const defaultDuplicateOptions: DuplicateScanOptions = {
  mediaType: 'ALL',
  pixelThreshold: 0.005,
  sampleSize: 96,
  videoFrames: 3,
  maxComparisons: 2000,
};

type DuplicatesUiStore = {
  duplicateOptions: DuplicateScanOptions;
  duplicateResolvedKeys: string[];
  setDuplicateOptions: (
    next:
      | DuplicateScanOptions
      | ((prev: DuplicateScanOptions) => DuplicateScanOptions)
  ) => void;
  setDuplicateResolvedKeys: (
    next: string[] | ((prev: string[]) => string[])
  ) => void;
  resetDuplicatesUiState: () => void;
};

export const useDuplicatesUiStore = create<DuplicatesUiStore>((set) => ({
  duplicateOptions: defaultDuplicateOptions,
  duplicateResolvedKeys: [],
  setDuplicateOptions: (next) =>
    set((state) => ({
      duplicateOptions:
        typeof next === 'function' ? next(state.duplicateOptions) : next,
    })),
  setDuplicateResolvedKeys: (next) =>
    set((state) => ({
      duplicateResolvedKeys:
        typeof next === 'function' ? next(state.duplicateResolvedKeys) : next,
    })),
  resetDuplicatesUiState: () =>
    set({
      duplicateOptions: defaultDuplicateOptions,
      duplicateResolvedKeys: [],
    }),
}));
