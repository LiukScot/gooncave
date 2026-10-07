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
  resetSettingsUiState: () => void;
};

export const useSettingsUiStore = create<SettingsUiStore>((set) => ({
  credentialLastProvider: null,
  credentialInputs: defaultCredentialInputs,
  credentialExpanded: defaultCredentialExpanded,
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
  resetSettingsUiState: () =>
    set({
      credentialLastProvider: null,
      credentialInputs: defaultCredentialInputs,
      credentialExpanded: defaultCredentialExpanded,
    }),
}));
