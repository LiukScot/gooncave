import { create } from 'zustand';

import { ACCENT_IDS, DEFAULT_ACCENT, type AppearanceAccent } from '@/lib/accents';

export type { AppearanceAccent };

export type AppearanceMode = 'light' | 'dark' | 'system';

/** What each page can show beside its main corner button. */
export const QUICK_ACTIONS = {
  gallery: ['add', 'sync', 'none'],
  explore: ['unread', 'subscribe', 'none'],
  file: ['share', 'vote', 'delete', 'keep', 'none'],
  post: ['favorite', 'vote', 'share', 'none']
} as const;

export type QuickPage = keyof typeof QUICK_ACTIONS;
export type QuickAction = (typeof QUICK_ACTIONS)[QuickPage][number];
export type QuickActions = { [Page in QuickPage]: (typeof QUICK_ACTIONS)[Page][number] };

export type Appearance = {
  mode: AppearanceMode;
  accent: AppearanceAccent;
  quickActions: QuickActions;
};

const STORAGE_KEY = 'gooncave:appearance';
const MODES: readonly AppearanceMode[] = ['light', 'dark', 'system'];

// A `style` written by an older version is ignored: the app has one look.
export const DEFAULT_APPEARANCE: Appearance = {
  mode: 'system',
  accent: DEFAULT_ACCENT,
  quickActions: { gallery: 'add', explore: 'unread', file: 'share', post: 'favorite' }
};

const parseQuickActions = (value: unknown): QuickActions => {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const defaults = DEFAULT_APPEARANCE.quickActions;
  return {
    gallery: QUICK_ACTIONS.gallery.find((action) => action === record.gallery) ?? defaults.gallery,
    explore: QUICK_ACTIONS.explore.find((action) => action === record.explore) ?? defaults.explore,
    file: QUICK_ACTIONS.file.find((action) => action === record.file) ?? defaults.file,
    post: QUICK_ACTIONS.post.find((action) => action === record.post) ?? defaults.post
  };
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
      ACCENT_IDS.find((accent) => accent === record.accent) ?? DEFAULT_APPEARANCE.accent,
    quickActions: parseQuickActions(record.quickActions)
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

const store = ({ mode, accent, quickActions }: Appearance): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, accent, quickActions }));
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
  setQuickAction: <Page extends QuickPage>(page: Page, action: QuickActions[Page]) => void;
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
  },
  setQuickAction: (page, action) => {
    set({ quickActions: { ...get().quickActions, [page]: action } });
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
