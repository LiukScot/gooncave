import { create } from 'zustand';

type DuplicatesUiStore = {
  duplicateResolvedKeys: string[];
  setDuplicateResolvedKeys: (
    next: string[] | ((prev: string[]) => string[])
  ) => void;
  resetDuplicatesUiState: () => void;
};

export const useDuplicatesUiStore = create<DuplicatesUiStore>((set) => ({
  duplicateResolvedKeys: [],
  setDuplicateResolvedKeys: (next) =>
    set((state) => ({
      duplicateResolvedKeys:
        typeof next === 'function' ? next(state.duplicateResolvedKeys) : next,
    })),
  resetDuplicatesUiState: () =>
    set({
      duplicateResolvedKeys: [],
    }),
}));
