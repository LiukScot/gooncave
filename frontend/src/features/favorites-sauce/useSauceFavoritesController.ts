import { useMemo, useState } from 'react';

import type { SauceFavoritesSettingsProps } from './SauceFavoritesSettings';

import type {
  AuthUser,
  CredentialProvider,
  CredentialSummary,
  FavoriteSyncStatus,
  SauceProgress,
  SauceSettings,
  SauceSource
} from '@/api';
import type { FavoritesAccountsSettingsProps } from '@/features/favorites-accounts/FavoritesAccountsSettings';
import { useCredentials, useUpdateCredential } from '@/hooks/credentials';
import {
  useFavoritesSettings,
  useFavoritesSyncStatus,
  useSyncFavorites,
  useUpdateFavoritesSettings
} from '@/hooks/favorites';
import { useSauces, useUpdateSauceSettings } from '@/hooks/sauces';
import { useSettingsUiStore } from '@/stores/settingsUiStore';

type FetchState = { loading: boolean; error: string | null };

type FavoritesRootSettings = {
  favoritesRootId: string | null;
};

interface SauceProgressSegments {
  matched: number;
  failed: number;
  pending: number;
}

const emptySauceProgress: SauceProgress = {
  total: 0,
  matched: 0,
  failed: 0,
  pending: 0,
  videos: 0,
  failedImages: 0
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
  'www.danbooru.donmai.us': 'danbooru'
};

const canonicalizeSauceKey = (value: string): string => {
  const key = normalizeSauceKey(value);
  if (canonicalSauces[key]) return canonicalSauces[key];
  if (key.endsWith('.e621.net')) return 'e621';
  return key;
};

const isCredentialReady = (
  provider: CredentialProvider,
  credential: CredentialSummary | undefined
): boolean => {
  if (!credential) return false;
  if (provider === 'SAUCENAO') return credential.hasApiKey;
  return Boolean(credential.username) && credential.hasApiKey;
};

export type SauceFavoritesControllerInput = {
  authUser: AuthUser | null;
};

export type SauceFavoritesControllerOutput = {
  sauceSettingsProps: SauceFavoritesSettingsProps;
  favoritesAccountsProps: FavoritesAccountsSettingsProps;
  sauceSettings: SauceSettings;
  favoritesRootSettings: FavoritesRootSettings;
  favoritesRootSettingsState: FetchState;
  updateFavoritesRoot: (favoritesRootId: string | null) => Promise<void>;
};

export function useSauceFavoritesController(
  input: SauceFavoritesControllerInput
): SauceFavoritesControllerOutput {
  const { authUser } = input;
  const enabled = Boolean(authUser);

  const saucesQuery = useSauces({ enabled });
  const updateSauceSettingsMutation = useUpdateSauceSettings();

  const favoritesSettingsQuery = useFavoritesSettings({ enabled });
  const updateFavoritesSettingsMutation = useUpdateFavoritesSettings();

  const syncFavoritesMutation = useSyncFavorites();

  const favoritesSyncStatusQuery = useFavoritesSyncStatus({
    enabled,
    refetchInterval: (query) => {
      const data = query.state.data as FavoriteSyncStatus | undefined;
      return data?.status === 'running' ? 2000 : false;
    }
  });
  const favoritesSyncStatus = favoritesSyncStatusQuery.data ?? null;

  const credentialsQuery = useCredentials({ enabled });
  const updateCredentialMutation = useUpdateCredential();

  const [sauceState, setSauceState] = useState<FetchState>({
    loading: false,
    error: null
  });
  const [favoritesSyncState, setFavoritesSyncState] = useState<FetchState>({
    loading: false,
    error: null
  });
  const [credentialsState, setCredentialsState] = useState<FetchState>({
    loading: false,
    error: null
  });

  const credentialLastProvider = useSettingsUiStore(
    (state) => state.credentialLastProvider
  );
  const setCredentialLastProvider = useSettingsUiStore(
    (state) => state.setCredentialLastProvider
  );
  const credentialInputs = useSettingsUiStore(
    (state) => state.credentialInputs
  );
  const setCredentialInputs = useSettingsUiStore(
    (state) => state.setCredentialInputs
  );
  const credentialExpanded = useSettingsUiStore(
    (state) => state.credentialExpanded
  );
  const setCredentialExpanded = useSettingsUiStore(
    (state) => state.setCredentialExpanded
  );
  const booruDevOptions = useSettingsUiStore((state) => state.booruDevOptions);
  const setBooruDevOptions = useSettingsUiStore(
    (state) => state.setBooruDevOptions
  );

  const sauceSources: SauceSource[] = useMemo(
    () => saucesQuery.data?.sources ?? [],
    [saucesQuery.data?.sources]
  );
  const sauceSettings: SauceSettings = useMemo(
    () => ({
      display: saucesQuery.data?.settings.display ?? [],
      targets: saucesQuery.data?.settings.targets ?? [],
      displayInitialized: saucesQuery.data?.settings.displayInitialized ?? false
    }),
    [saucesQuery.data]
  );
  const sauceProgress: SauceProgress =
    saucesQuery.data?.progress ?? emptySauceProgress;

  const favoritesRootSettings: FavoritesRootSettings = useMemo(
    () => favoritesSettingsQuery.data ?? { favoritesRootId: null },
    [favoritesSettingsQuery.data]
  );

  const favoritesRootSettingsState: FetchState = {
    loading: favoritesSettingsQuery.isFetching,
    error: favoritesSettingsQuery.error
      ? (favoritesSettingsQuery.error as Error).message
      : null
  };

  const credentials = useMemo(
    () => credentialsQuery.data ?? [],
    [credentialsQuery.data]
  );
  const credentialMap = useMemo(() => {
    const map = new Map<CredentialProvider, CredentialSummary>();
    credentials.forEach((entry) => map.set(entry.provider, entry));
    return map;
  }, [credentials]);

  const saucenaoReady = isCredentialReady(
    'SAUCENAO',
    credentialMap.get('SAUCENAO')
  );

  const sauceKeys = useMemo(
    () => sauceSources.map((source) => canonicalizeSauceKey(source.key)),
    [sauceSources]
  );
  const displayFilterActive =
    (sauceSettings.displayInitialized ?? false) ||
    sauceSettings.display.length > 0;

  const displaySet = useMemo(() => {
    if (!displayFilterActive) return new Set(sauceKeys);
    return new Set(sauceSettings.display.map(canonicalizeSauceKey));
  }, [displayFilterActive, sauceSettings.display, sauceKeys]);

  const targetSet = useMemo(
    () => new Set(sauceSettings.targets.map(canonicalizeSauceKey)),
    [sauceSettings.targets]
  );

  const sauceProgressSegments = useMemo((): SauceProgressSegments => {
    const total = sauceProgress.total;
    if (!total) return { matched: 0, failed: 0, pending: 0 };
    const matched = (sauceProgress.matched / total) * 100;
    const failed = (sauceProgress.failed / total) * 100;
    return { matched, failed, pending: Math.max(0, 100 - matched - failed) };
  }, [sauceProgress]);

  const favoritesSummary = useMemo(() => {
    if (!favoritesSyncStatus?.results?.length) return [];
    return favoritesSyncStatus.results.map((entry) => {
      const errors = entry.errors.length
        ? ` • ${entry.errors.length} errors`
        : '';
      return `${entry.provider}: ${entry.added} added, ${entry.removed} removed, ${entry.skipped} skipped, ${entry.fetched} fetched${errors}`;
    });
  }, [favoritesSyncStatus]);

  const favoritesErrors = useMemo(() => {
    if (!favoritesSyncStatus?.results?.length) return [];
    return favoritesSyncStatus.results.flatMap((entry) =>
      entry.errors.map((error) => `${entry.provider}: ${error}`)
    );
  }, [favoritesSyncStatus]);

  const favoritesProgress = useMemo(() => {
    const providers = favoritesSyncStatus?.progress?.providers ?? [];
    const total = providers.reduce((sum, entry) => sum + (entry.total || 0), 0);
    const processed = providers.reduce(
      (sum, entry) => sum + Math.min(entry.processed || 0, entry.total || 0),
      0
    );
    if (!total) return null;
    return Math.min(100, Math.round((processed / total) * 100));
  }, [favoritesSyncStatus]);

  const saveSauceSettings = async (next: SauceSettings) => {
    const displayInitialized =
      next.displayInitialized ?? sauceSettings.displayInitialized ?? false;
    const nextSettings: SauceSettings = {
      display: next.display ?? [],
      targets: next.targets ?? [],
      displayInitialized
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
      displayInitialized: true
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
    void saveSauceSettings({
      display: sauceSettings.display,
      targets: Array.from(base)
    });
  };

  const setAllDisplay = (value: boolean) => {
    const next = value ? sauceKeys : [];
    void saveSauceSettings({
      display: next,
      targets: sauceSettings.targets,
      displayInitialized: true
    });
  };

  const setAllTargets = (value: boolean) => {
    const next = value ? sauceKeys : [];
    void saveSauceSettings({ display: sauceSettings.display, targets: next });
  };

  const runFavoritesSync = async (deleteMissing: boolean): Promise<void> => {
    setFavoritesSyncState({ loading: true, error: null });
    try {
      await syncFavoritesMutation.mutateAsync({ deleteMissing });
      setFavoritesSyncState({ loading: false, error: null });
    } catch (err) {
      setFavoritesSyncState({ loading: false, error: (err as Error).message });
    }
  };

  const updateFavoritesRoot = async (
    favoritesRootId: string | null
  ): Promise<void> => {
    try {
      await updateFavoritesSettingsMutation.mutateAsync({ favoritesRootId });
    } catch (err) {
      throw err;
    }
  };

  const updateCredentialInput = (
    provider: CredentialProvider,
    field: 'username' | 'apiKey',
    value: string
  ) => {
    setCredentialInputs((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], [field]: value }
    }));
  };

  const saveCredential = async (
    provider: CredentialProvider
  ): Promise<void> => {
    setCredentialLastProvider(provider);
    setCredentialsState({ loading: true, error: null });
    try {
      const inputEntry = credentialInputs[provider];
      const username = inputEntry.username.trim();
      const apiKey = inputEntry.apiKey.trim();
      const payload: {
        provider: CredentialProvider;
        username?: string;
        apiKey?: string;
      } = { provider };
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
          username:
            provider === 'SAUCENAO'
              ? ''
              : (updated.username ?? prev[provider].username),
          apiKey: ''
        }
      }));
      setCredentialExpanded((prev) => ({ ...prev, [provider]: false }));
      setCredentialsState({ loading: false, error: null });
    } catch (err) {
      setCredentialsState({ loading: false, error: (err as Error).message });
    }
  };

  const logoutCredential = async (
    provider: CredentialProvider
  ): Promise<void> => {
    setCredentialLastProvider(provider);
    setCredentialsState({ loading: true, error: null });
    try {
      await updateCredentialMutation.mutateAsync({
        provider,
        username: '',
        apiKey: ''
      });
      setCredentialInputs((prev) => ({
        ...prev,
        [provider]: { username: '', apiKey: '' }
      }));
      setCredentialExpanded((prev) => ({ ...prev, [provider]: false }));
      setCredentialsState({ loading: false, error: null });
    } catch (err) {
      setCredentialsState({ loading: false, error: (err as Error).message });
    }
  };

  const setBooruDevOptionsPersistent = (next: boolean) => {
    setBooruDevOptions(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('booru:devOptions', next ? '1' : '0');
    }
  };

  const sauceSettingsProps: SauceFavoritesSettingsProps = {
    sauceSources,
    sauceProgress,
    sauceState,
    sauceProgressSegments,
    displaySet,
    targetSet,
    saucenaoReady,
    credentialsState,
    credentialLastProvider,
    credentialInputs,
    credentialExpanded,
    toggleDisplaySauce,
    toggleTargetSauce,
    setAllDisplay,
    setAllTargets,
    logoutCredential,
    saveCredential,
    updateCredentialInput,
    setCredentialExpanded
  };

  const favoritesAccountsProps: FavoritesAccountsSettingsProps = {
    favoritesSyncState,
    favoritesSyncStatus,
    favoritesProgress,
    favoritesSummary,
    favoritesErrors,
    runFavoritesSync,
    booruDevOptions,
    setBooruDevOptionsPersistent
  };

  return {
    sauceSettingsProps,
    favoritesAccountsProps,
    sauceSettings,
    favoritesRootSettings,
    favoritesRootSettingsState,
    updateFavoritesRoot
  };
}
