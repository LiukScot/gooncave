import { create } from 'zustand';

import type { CredentialProvider } from '@/api';

type CredentialInputState = Record<
  CredentialProvider,
  { username: string; apiKey: string }
>;

type CredentialExpandedState = Record<CredentialProvider, boolean>;

const defaultCredentialInputs: CredentialInputState = {
  E621: { username: '', apiKey: '' },
  DANBOORU: { username: '', apiKey: '' },
  SAUCENAO: { username: '', apiKey: '' },
};

const defaultCredentialExpanded: CredentialExpandedState = {
  E621: false,
  DANBOORU: false,
  SAUCENAO: false,
};

type SettingsUiStore = {
  credentialLastProvider: CredentialProvider | null;
  credentialInputs: CredentialInputState;
  credentialExpanded: CredentialExpandedState;
  booruDevOptions: boolean;
  setCredentialLastProvider: (provider: CredentialProvider | null) => void;
  setCredentialInputs: (
    next:
      | CredentialInputState
      | ((prev: CredentialInputState) => CredentialInputState)
  ) => void;
  setCredentialExpanded: (
    next:
      | CredentialExpandedState
      | ((prev: CredentialExpandedState) => CredentialExpandedState)
  ) => void;
  setBooruDevOptions: (value: boolean) => void;
  resetSettingsUiState: () => void;
};

const resolveInitialBooruDevOptions = () => {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem('booru:devOptions') === '1';
};

export const useSettingsUiStore = create<SettingsUiStore>((set) => ({
  credentialLastProvider: null,
  credentialInputs: defaultCredentialInputs,
  credentialExpanded: defaultCredentialExpanded,
  booruDevOptions: resolveInitialBooruDevOptions(),
  setCredentialLastProvider: (credentialLastProvider) => set({ credentialLastProvider }),
  setCredentialInputs: (next) =>
    set((state) => ({
      credentialInputs:
        typeof next === 'function' ? next(state.credentialInputs) : next,
    })),
  setCredentialExpanded: (next) =>
    set((state) => ({
      credentialExpanded:
        typeof next === 'function' ? next(state.credentialExpanded) : next,
    })),
  setBooruDevOptions: (booruDevOptions) => set({ booruDevOptions }),
  resetSettingsUiState: () =>
    set((state) => ({
      credentialLastProvider: null,
      credentialInputs: defaultCredentialInputs,
      credentialExpanded: defaultCredentialExpanded,
      booruDevOptions: state.booruDevOptions,
    })),
}));
