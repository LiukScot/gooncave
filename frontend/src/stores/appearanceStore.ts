import { create } from 'zustand';

import { ACCENT_IDS, type AppearanceAccent } from '@/lib/accents';

export type { AppearanceAccent };

export type AppearanceMode = 'light' | 'dark' | 'system';

export type Appearance = {
  mode: AppearanceMode;
  accent: AppearanceAccent;
};

const STORAGE_KEY = 'gooncave:appearance';
const MODES: readonly AppearanceMode[] = ['light', 'dark', 'system'];

// A `style` written by an older version is ignored: the app has one look.
export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'dark',
  accent: 'blue'
};

/** Reads a stored choice; anything unrecognised falls back field by field. */
export const parseAppearance = (raw: string | null): Appearance => {
  if (!raw) return DEFAULT_APPEARANCE;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    console.warn('Ignoring unreadable appearance setting', raw);
    return DEFAULT_APPEARANCE;
  }
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    mode: MODES.find((mode) => mode === record.mode) ?? DEFAULT_APPEARANCE.mode,
    accent:
      ACCENT_IDS.find((accent) => accent === record.accent) ?? DEFAULT_APPEARANCE.accent
  };
};

const readStored = (): Appearance => {
  try {
    return parseAppearance(window.localStorage.getItem(STORAGE_KEY));
  } catch (error) {
    // Storage blocked (private mode, site data off): the choice lasts the visit.
    console.warn('Could not read the appearance setting', error);
    return DEFAULT_APPEARANCE;
  }
};

const store = ({ mode, accent }: Appearance): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, accent }));
  } catch (error) {
    console.warn('Could not save the appearance setting', error);
  }
};

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

type AppearanceStore = Appearance & {
  /** Whether the device asks for dark, which `system` follows. */
  systemDark: boolean;
  setMode: (mode: AppearanceMode) => void;
  setAccent: (accent: AppearanceAccent) => void;
};

export const useAppearanceStore = create<AppearanceStore>((set, get) => ({
  ...readStored(),
  systemDark: darkQuery.matches,
  setMode: (mode) => {
    set({ mode });
    store(get());
  },
  setAccent: (accent) => {
    set({ accent });
    store(get());
  }
}));

darkQuery.addEventListener('change', (event) =>
  useAppearanceStore.setState({ systemDark: event.matches })
);

export const isDark = ({
  mode,
  systemDark
}: Pick<AppearanceStore, 'mode' | 'systemDark'>): boolean =>
  mode === 'system' ? systemDark : mode === 'dark';
