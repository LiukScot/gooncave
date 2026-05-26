import { useMemo, useState } from 'react';

import type { AuthUser, CredentialProvider, CredentialSummary, FavoriteSyncStatus, SauceProgress, SauceSettings, SauceSource } from '@/api';
import { useCredentials, useUpdateCredential } from '@/hooks/credentials';
import { useFavoritesSettings, useFavoritesSyncStatus, useSyncFavorites, useUpdateFavoritesSettings } from '@/hooks/favorites';
import { useSauces, useUpdateSauceSettings } from '@/hooks/sauces';
import type { SauceFavoritesSettingsProps } from './SauceFavoritesSettings';

// ---------------------------------------------------------------------------
// Local types (mirror App.tsx local types; not exported from api)
// ---------------------------------------------------------------------------

type FetchState = { loading: boolean; error: string | null };

interface FavoritesSettings {
  reverseSyncEnabled: boolean;
  autoSyncMidnight: boolean;
  autoFavEnabled: boolean;
  favoritesRootId: string | null;
}

interface SauceProgressSegments {
  matched: number;
  failed: number;
  pending: number;
}

// ---------------------------------------------------------------------------
// Helpers (mirrored from App.tsx)
// ---------------------------------------------------------------------------

const emptySauceProgress: SauceProgress = {
  total: 0,
  matched: 0,
  failed: 0,
  pending: 0,
  videos: 0,
  failedImages: 0,
};

const normalizeSauceKey = (value: string) => value.trim().toLowerCase();

const canonicalSauces: Record<string, string> = {
  'e621.net': 'e621',
  'www.e621.net': 'e621',
  'static1.e621.net': 'e621',
  'static2.e621.net': 'e621',
  'static3.e621.net': 'e621',
  'static4.e621.net': 'e621',
  'danbooru.donmai.us': 'danbooru',
  'www.danbooru.donmai.us': 'danbooru',
};

const canonicalizeSauceKey = (value: string): string => {
  const key = normalizeSauceKey(value);
  if (canonicalSauces[key]) return canonicalSauces[key];
  if (key.endsWith('.e621.net')) return 'e621';
  return key;
};

const isCredentialReady = (
  provider: CredentialProvider,
  credential: CredentialSummary | undefined,
): boolean => {
  if (!credential) return false;
  if (provider === 'SAUCENAO') return credential.hasApiKey;
  return Boolean(credential.username) && credential.hasApiKey;
};

// ---------------------------------------------------------------------------
// Hook I/O types
// ---------------------------------------------------------------------------

export type SauceFavoritesControllerInput = {
  /** Gates all queries — pass null when not authenticated. */
  authUser: AuthUser | null;
};

export type SauceFavoritesControllerOutput = {
  /** Exact prop bag consumed by SauceFavoritesSettings. */
  settingsProps: SauceFavoritesSettingsProps;
  /** Shared with file-detail panel (displayFilterActive). */
  sauceSettings: SauceSettings;
  /** Credential ready flags consumed by file-detail provider scan. */
  credentialsReady: { E621: boolean; DANBOORU: boolean; SAUCENAO: boolean };
  /** Raw sync status exposed to callers that track running state. */
  favoritesSyncStatus: FavoriteSyncStatus | null;
};

// ---------------------------------------------------------------------------
// Controller hook
// ---------------------------------------------------------------------------

export function useSauceFavoritesController(
  input: SauceFavoritesControllerInput,
): SauceFavoritesControllerOutput {
  const { authUser } = input;
  const enabled = Boolean(authUser);

  // ------------------------------------------------------------------
  // TanStack queries
  // ------------------------------------------------------------------

  const saucesQuery = useSauces({ enabled });
  const updateSauceSettingsMutation = useUpdateSauceSettings();

  const favoritesSettingsQuery = useFavoritesSettings({ enabled });
  const updateFavoritesSettingsMutation = useUpdateFavoritesSettings();

  const syncFavoritesMutation = useSyncFavorites();

  // Derive whether a sync is actively running so we can drive refetchInterval
  // from query data rather than a separate setInterval.
  // We read from the query cache first; if undefined, treat as not running.
  const favoritesSyncStatusQuery = useFavoritesSyncStatus({
    enabled,
    // Poll every 2 s while a sync is running; TanStack Query stops when tab is
    // hidden and resumes automatically — cleaner than a manual setInterval.
    refetchInterval: (query) => {
      const data = query.state.data as FavoriteSyncStatus | undefined;
      return data?.status === 'running' ? 2000 : false;
    },
  });
  const favoritesSyncStatus = favoritesSyncStatusQuery.data ?? null;

  const credentialsQuery = useCredentials({ enabled });
  const updateCredentialMutation = useUpdateCredential();

  // ------------------------------------------------------------------
  // Local state that the UI still needs (loading/error overlays)
  // ------------------------------------------------------------------

  const [sauceState, setSauceState] = useState<FetchState>({ loading: false, error: null });
  const [favoritesSyncState, setFavoritesSyncState] = useState<FetchState>({ loading: false, error: null });
  const [credentialsState, setCredentialsState] = useState<FetchState>({ loading: false, error: null });
  const [credentialLastProvider, setCredentialLastProvider] = useState<CredentialProvider | null>(null);
  const [credentialInputs, setCredentialInputs] = useState<
    Record<CredentialProvider, { username: string; apiKey: string }>
  >({
    E621: { username: '', apiKey: '' },
    DANBOORU: { username: '', apiKey: '' },
    SAUCENAO: { username: '', apiKey: '' },
  });
  const [credentialExpanded, setCredentialExpanded] = useState<Record<CredentialProvider, boolean>>({
    E621: false,
    DANBOORU: false,
    SAUCENAO: false,
  });

  // booruDevOptions persisted in localStorage
  const [booruDevOptions, setBooruDevOptions] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('booru:devOptions') === '1';
  });

  // ------------------------------------------------------------------
  // Derived data from queries
  // ------------------------------------------------------------------

  const sauceSources: SauceSource[] = saucesQuery.data?.sources ?? [];
  const sauceSettings: SauceSettings = useMemo(
    () => ({
      display: saucesQuery.data?.settings.display ?? [],
      targets: saucesQuery.data?.settings.targets ?? [],
      displayInitialized: saucesQuery.data?.settings.displayInitialized ?? false,
    }),
    [saucesQuery.data],
  );
  const sauceProgress: SauceProgress = saucesQuery.data?.progress ?? emptySauceProgress;

  const favoritesSettings: FavoritesSettings = useMemo(
    () =>
      favoritesSettingsQuery.data ?? {
        reverseSyncEnabled: false,
        autoSyncMidnight: false,
        autoFavEnabled: false,
        favoritesRootId: null,
      },
    [favoritesSettingsQuery.data],
  );
  const favoritesSettingsState: FetchState = {
    loading: favoritesSettingsQuery.isFetching,
    error: favoritesSettingsQuery.error ? (favoritesSettingsQuery.error as Error).message : null,
  };

  const credentials = credentialsQuery.data ?? [];
  const credentialMap = useMemo(() => {
    const map = new Map<CredentialProvider, CredentialSummary>();
    credentials.forEach((entry) => map.set(entry.provider, entry));
    return map;
  }, [credentials]);

  const e621Ready = isCredentialReady('E621', credentialMap.get('E621'));
  const danbooruReady = isCredentialReady('DANBOORU', credentialMap.get('DANBOORU'));
  const saucenaoReady = isCredentialReady('SAUCENAO', credentialMap.get('SAUCENAO'));

  // ------------------------------------------------------------------
  // Sauce derived values
  // ------------------------------------------------------------------

  const sauceKeys = useMemo(
    () => sauceSources.map((source) => canonicalizeSauceKey(source.key)),
    [sauceSources],
  );
  const displayFilterActive =
    (sauceSettings.displayInitialized ?? false) || sauceSettings.display.length > 0;

  const displaySet = useMemo(() => {
    if (!displayFilterActive) return new Set(sauceKeys);
    return new Set(sauceSettings.display.map(canonicalizeSauceKey));
  }, [displayFilterActive, sauceSettings.display, sauceKeys]);

  const targetSet = useMemo(
    () => new Set(sauceSettings.targets.map(canonicalizeSauceKey)),
    [sauceSettings.targets],
  );

  const sauceProgressSegments = useMemo((): SauceProgressSegments => {
    const total = sauceProgress.total;
    if (!total) return { matched: 0, failed: 0, pending: 0 };
    const matched = (sauceProgress.matched / total) * 100;
    const failed = (sauceProgress.failed / total) * 100;
    return { matched, failed, pending: Math.max(0, 100 - matched - failed) };
  }, [sauceProgress]);

  // ------------------------------------------------------------------
  // Favorites derived values
  // ------------------------------------------------------------------

  const favoritesSummary = useMemo(() => {
    if (!favoritesSyncStatus?.results?.length) return [];
    return favoritesSyncStatus.results.map((entry) => {
      const errors = entry.errors.length ? ` • ${entry.errors.length} errors` : '';
      return `${entry.provider}: ${entry.added} added, ${entry.removed} removed, ${entry.skipped} skipped, ${entry.fetched} fetched${errors}`;
    });
  }, [favoritesSyncStatus]);

  const favoritesErrors = useMemo(() => {
    if (!favoritesSyncStatus?.results?.length) return [];
    return favoritesSyncStatus.results.flatMap((entry) =>
      entry.errors.map((error) => `${entry.provider}: ${error}`),
    );
  }, [favoritesSyncStatus]);

  const favoritesProgress = useMemo(() => {
    const providers = favoritesSyncStatus?.progress?.providers ?? [];
    const total = providers.reduce((sum, entry) => sum + (entry.total || 0), 0);
    const processed = providers.reduce(
      (sum, entry) => sum + Math.min(entry.processed || 0, entry.total || 0),
      0,
    );
    if (!total) return null;
    return Math.min(100, Math.round((processed / total) * 100));
  }, [favoritesSyncStatus]);

  // ------------------------------------------------------------------
  // Sauce handlers
  // ------------------------------------------------------------------

  const saveSauceSettings = async (next: SauceSettings) => {
    const displayInitialized = next.displayInitialized ?? sauceSettings.displayInitialized ?? false;
    const nextSettings: SauceSettings = {
      display: next.display ?? [],
      targets: next.targets ?? [],
      displayInitialized,
    };
    setSauceState({ loading: true, error: null });
    try {
      await updateSauceSettingsMutation.mutateAsync(nextSettings);
      setSauceState({ loading: false, error: null });
    } catch (err) {
      setSauceState({ loading: false, error: (err as Error).message });
    }
  };

  const toggleDisplaySauce = (key: string) => {
    const base = displayFilterActive
      ? new Set(sauceSettings.display.map(canonicalizeSauceKey))
      : new Set(sauceKeys);
    const normalized = canonicalizeSauceKey(key);
    if (base.has(normalized)) {
      base.delete(normalized);
    } else {
      base.add(normalized);
    }
    void saveSauceSettings({
      display: Array.from(base),
      targets: sauceSettings.targets,
      displayInitialized: true,
    });
  };

  const toggleTargetSauce = (key: string) => {
    const base = new Set(sauceSettings.targets.map(canonicalizeSauceKey));
    const normalized = canonicalizeSauceKey(key);
    if (base.has(normalized)) {
      base.delete(normalized);
    } else {
      base.add(normalized);
    }
    void saveSauceSettings({ display: sauceSettings.display, targets: Array.from(base) });
  };

  const setAllDisplay = (value: boolean) => {
    const next = value ? sauceKeys : [];
    void saveSauceSettings({ display: next, targets: sauceSettings.targets, displayInitialized: true });
  };

  const setAllTargets = (value: boolean) => {
    const next = value ? sauceKeys : [];
    void saveSauceSettings({ display: sauceSettings.display, targets: next });
  };

  // ------------------------------------------------------------------
  // Favorites handlers
  // ------------------------------------------------------------------

  const runFavoritesSync = async (deleteMissing: boolean): Promise<void> => {
    setFavoritesSyncState({ loading: true, error: null });
    try {
      await syncFavoritesMutation.mutateAsync({ deleteMissing });
      setFavoritesSyncState({ loading: false, error: null });
      // refetchInterval on the status query takes over polling from here
    } catch (err) {
      setFavoritesSyncState({ loading: false, error: (err as Error).message });
    }
  };

  const updateFavoritesSettings = async (
    updates: Partial<Omit<FavoritesSettings, 'favoritesRootId'> & { favoritesRootId?: string | null }>,
  ): Promise<void> => {
    try {
      await updateFavoritesSettingsMutation.mutateAsync(updates);
    } catch (err) {
      // error surfaced via favoritesSettingsState.error from query
      throw err;
    }
  };

  // ------------------------------------------------------------------
  // Credential handlers
  // ------------------------------------------------------------------

  const updateCredentialInput = (
    provider: CredentialProvider,
    field: 'username' | 'apiKey',
    value: string,
  ) => {
    setCredentialInputs((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], [field]: value },
    }));
  };

  const saveCredential = async (provider: CredentialProvider): Promise<void> => {
    setCredentialLastProvider(provider);
    setCredentialsState({ loading: true, error: null });
    try {
      const inputEntry = credentialInputs[provider];
      const username = inputEntry.username.trim();
      const apiKey = inputEntry.apiKey.trim();
      const payload: { provider: CredentialProvider; username?: string; apiKey?: string } = { provider };
      if (provider !== 'SAUCENAO' && username) {
        payload.username = username;
      }
      if (apiKey) {
        payload.apiKey = apiKey;
      }
      if (!payload.username && !payload.apiKey) {
        setCredentialsState({ loading: false, error: null });
        return;
      }
      const updated = await updateCredentialMutation.mutateAsync(payload);
      setCredentialInputs((prev) => ({
        ...prev,
        [provider]: {
          username: provider === 'SAUCENAO' ? '' : (updated.username ?? prev[provider].username),
          apiKey: '',
        },
      }));
      setCredentialExpanded((prev) => ({ ...prev, [provider]: false }));
      setCredentialsState({ loading: false, error: null });
    } catch (err) {
      setCredentialsState({ loading: false, error: (err as Error).message });
    }
  };

  const logoutCredential = async (provider: CredentialProvider): Promise<void> => {
    setCredentialLastProvider(provider);
    setCredentialsState({ loading: true, error: null });
    try {
      await updateCredentialMutation.mutateAsync({ provider, username: '', apiKey: '' });
      setCredentialInputs((prev) => ({
        ...prev,
        [provider]: { username: '', apiKey: '' },
      }));
      setCredentialExpanded((prev) => ({ ...prev, [provider]: false }));
      setCredentialsState({ loading: false, error: null });
    } catch (err) {
      setCredentialsState({ loading: false, error: (err as Error).message });
    }
  };

  // ------------------------------------------------------------------
  // Dev options handler
  // ------------------------------------------------------------------

  const setBooruDevOptionsPersistent = (next: boolean) => {
    setBooruDevOptions(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('booru:devOptions', next ? '1' : '0');
    }
  };

  // ------------------------------------------------------------------
  // Assemble settingsProps
  // ------------------------------------------------------------------

  const settingsProps: SauceFavoritesSettingsProps = {
    // Sauce state
    sauceSources,
    sauceProgress,
    sauceState,
    sauceProgressSegments,
    displaySet,
    targetSet,

    // Favorites state
    favoritesSyncState,
    favoritesSyncStatus,
    favoritesSettings,
    favoritesSettingsState,
    favoritesProgress,
    favoritesSummary,
    favoritesErrors,

    // Legacy credential state
    e621Ready,
    danbooruReady,
    saucenaoReady,
    credentialsState,
    credentialLastProvider,
    credentialInputs,
    credentialExpanded,

    // Dev options
    booruDevOptions,

    // Handlers — sauce
    toggleDisplaySauce,
    toggleTargetSauce,
    setAllDisplay,
    setAllTargets,

    // Handlers — favorites
    runFavoritesSync,
    updateFavoritesSettings,

    // Handlers — credentials
    logoutCredential,
    saveCredential,
    updateCredentialInput,
    setCredentialExpanded,

    // Handlers — dev options
    setBooruDevOptionsPersistent,
  };

  return {
    settingsProps,
    sauceSettings,
    credentialsReady: { E621: e621Ready, DANBOORU: danbooruReady, SAUCENAO: saucenaoReady },
    favoritesSyncStatus,
  };
}
