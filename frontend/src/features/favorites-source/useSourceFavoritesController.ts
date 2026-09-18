import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { SourceFavoritesSettingsProps } from './SourceFavoritesSettings';

import type {
  AuthUser,
  CredentialProvider,
  CredentialSummary,
  FavoriteSyncStatus,
  SourceProgress,
  SourceSettings,
  SourceEntry
} from '@/api';
import type { FavoritesAccountsSettingsProps } from '@/features/favorites-accounts/FavoritesAccountsSettings';
import { mapSourcesWithSiteNames } from '@/features/favorites-source/sourceLabels';
import { useBooruSites } from '@/hooks/booru-sites';
import { useCredentials, useUpdateCredential } from '@/hooks/credentials';
import {
  useCancelFavoritesSync,
  useFavoritesSettings,
  useFavoritesSyncStatus,
  useSyncFavorites,
  useUpdateFavoritesSettings
} from '@/hooks/favorites';
import { useSources, useUpdateSourceSettings } from '@/hooks/sources';
import { queryKeys } from '@/lib/query-keys';
import { useSettingsUiStore } from '@/stores/settingsUiStore';

type FetchState = { loading: boolean; error: string | null };

type FavoritesRootSettings = {
  favoritesRootId: string | null;
};

interface SourceProgressSegments {
  matched: number;
  failed: number;
  pending: number;
}

const emptySourceProgress: SourceProgress = {
  total: 0,
  matched: 0,
  failed: 0,
  pending: 0,
  videos: 0,
  failedImages: 0
};

const normalizeSourceKey = (value: string) => value.trim().toLowerCase();

const canonicalSources: Record<string, string> = {
  'e621.net': 'e621',
  'www.e621.net': 'e621',
  'static1.e621.net': 'e621',
  'static2.e621.net': 'e621',
  'static3.e621.net': 'e621',
  'static4.e621.net': 'e621',
  'danbooru.donmai.us': 'danbooru',
  'www.danbooru.donmai.us': 'danbooru'
};

const canonicalizeSourceKey = (value: string): string => {
  const key = normalizeSourceKey(value);
  if (canonicalSources[key]) return canonicalSources[key];
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

export type SourceFavoritesControllerInput = {
  authUser: AuthUser | null;
};

export type SourceFavoritesControllerOutput = {
  sourceSettingsProps: SourceFavoritesSettingsProps;
  favoritesAccountsProps: FavoritesAccountsSettingsProps;
  sourceSettings: SourceSettings;
  favoritesRootSettings: FavoritesRootSettings;
  favoritesRootSettingsState: FetchState;
  updateFavoritesRoot: (favoritesRootId: string | null) => Promise<void>;
};

export function useSourceFavoritesController(
  input: SourceFavoritesControllerInput
): SourceFavoritesControllerOutput {
  const { authUser } = input;
  const enabled = Boolean(authUser);
  const queryClient = useQueryClient();

  const sourcesQuery = useSources({ enabled });
  const booruSitesQuery = useBooruSites({ enabled });
  const updateSourceSettingsMutation = useUpdateSourceSettings();

  const favoritesSettingsQuery = useFavoritesSettings({ enabled });
  const updateFavoritesSettingsMutation = useUpdateFavoritesSettings();

  const syncFavoritesMutation = useSyncFavorites();
  const cancelFavoritesMutation = useCancelFavoritesSync();

  const favoritesSyncStatusQuery = useFavoritesSyncStatus({
    enabled,
    refetchInterval: (query) => {
      const data = query.state.data as FavoriteSyncStatus | undefined;
      return data?.status === 'running' ? 2000 : false;
    }
  });
  const favoritesSyncStatus = favoritesSyncStatusQuery.data ?? null;
  const syncedAddedCount =
    favoritesSyncStatus?.progress?.providers.reduce(
      (sum, provider) => sum + provider.added,
      0
    ) ?? 0;
  const previousSyncedAddedCount = useRef(0);

  useEffect(() => {
    if (syncedAddedCount < previousSyncedAddedCount.current) {
      previousSyncedAddedCount.current = 0;
    }
    if (syncedAddedCount > previousSyncedAddedCount.current) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
    }
    previousSyncedAddedCount.current = syncedAddedCount;
  }, [queryClient, syncedAddedCount]);

  const credentialsQuery = useCredentials({ enabled });
  const updateCredentialMutation = useUpdateCredential();

  const [sourceState, setSourceState] = useState<FetchState>({
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

  const sources: SourceEntry[] = useMemo(
    () =>
      mapSourcesWithSiteNames(
        sourcesQuery.data?.sources ?? [],
        booruSitesQuery.data ?? []
      ),
    [booruSitesQuery.data, sourcesQuery.data?.sources]
  );
  const sourceSettings: SourceSettings = useMemo(
    () => ({
      display: sourcesQuery.data?.settings.display ?? [],
      targets: sourcesQuery.data?.settings.targets ?? [],
      displayInitialized: sourcesQuery.data?.settings.displayInitialized ?? false
    }),
    [sourcesQuery.data]
  );
  const sourceProgress: SourceProgress =
    sourcesQuery.data?.progress ?? emptySourceProgress;

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

  const sourceKeys = useMemo(
    () => sources.map((source) => canonicalizeSourceKey(source.key)),
    [sources]
  );
  const displayFilterActive =
    (sourceSettings.displayInitialized ?? false) ||
    sourceSettings.display.length > 0;

  const displaySet = useMemo(() => {
    if (!displayFilterActive) return new Set(sourceKeys);
    return new Set(sourceSettings.display.map(canonicalizeSourceKey));
  }, [displayFilterActive, sourceSettings.display, sourceKeys]);

  const targetSet = useMemo(
    () => new Set(sourceSettings.targets.map(canonicalizeSourceKey)),
    [sourceSettings.targets]
  );

  const sourceProgressSegments = useMemo((): SourceProgressSegments => {
    const total = sourceProgress.total;
    if (!total) return { matched: 0, failed: 0, pending: 0 };
    const matched = (sourceProgress.matched / total) * 100;
    const failed = (sourceProgress.failed / total) * 100;
    return { matched, failed, pending: Math.max(0, 100 - matched - failed) };
  }, [sourceProgress]);

  const favoritesSummary = useMemo(() => {
    if (!favoritesSyncStatus?.results?.length) return [];
    return favoritesSyncStatus.results.map((entry) => {
      const errors = entry.errors.length
        ? ` • ${entry.errors.length} errors`
        : '';
      return `${entry.siteName}: ${entry.added} added, ${entry.removed} removed, ${entry.skipped} skipped, ${entry.fetched} fetched${errors}`;
    });
  }, [favoritesSyncStatus]);

  const favoritesErrors = useMemo(() => {
    if (!favoritesSyncStatus?.results?.length) return [];
    return favoritesSyncStatus.results.flatMap((entry) =>
      entry.errors.map((error) => `${entry.siteName}: ${error}`)
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

  const saveSourceSettings = async (next: SourceSettings) => {
    const displayInitialized =
      next.displayInitialized ?? sourceSettings.displayInitialized ?? false;
    const nextSettings: SourceSettings = {
      display: next.display ?? [],
      targets: next.targets ?? [],
      displayInitialized
    };
    setSourceState({ loading: true, error: null });
    try {
      await updateSourceSettingsMutation.mutateAsync(nextSettings);
      setSourceState({ loading: false, error: null });
    } catch (err) {
      setSourceState({ loading: false, error: (err as Error).message });
    }
  };

  const toggleDisplaySource = (key: string) => {
    const base = displayFilterActive
      ? new Set(sourceSettings.display.map(canonicalizeSourceKey))
      : new Set(sourceKeys);
    const normalized = canonicalizeSourceKey(key);
    if (base.has(normalized)) {
      base.delete(normalized);
    } else {
      base.add(normalized);
    }
    void saveSourceSettings({
      display: Array.from(base),
      targets: sourceSettings.targets,
      displayInitialized: true
    });
  };

  const toggleTargetSource = (key: string) => {
    const base = new Set(sourceSettings.targets.map(canonicalizeSourceKey));
    const normalized = canonicalizeSourceKey(key);
    if (base.has(normalized)) {
      base.delete(normalized);
    } else {
      base.add(normalized);
    }
    void saveSourceSettings({
      display: sourceSettings.display,
      targets: Array.from(base)
    });
  };

  const setAllDisplay = (value: boolean) => {
    const next = value ? sourceKeys : [];
    void saveSourceSettings({
      display: next,
      targets: sourceSettings.targets,
      displayInitialized: true
    });
  };

  const setAllTargets = (value: boolean) => {
    const next = value ? sourceKeys : [];
    void saveSourceSettings({ display: sourceSettings.display, targets: next });
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

  const cancelFavoritesSync = async (): Promise<void> => {
    setFavoritesSyncState({ loading: true, error: null });
    try {
      await cancelFavoritesMutation.mutateAsync();
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

  const sourceSettingsProps: SourceFavoritesSettingsProps = {
    sources,
    sourceProgress,
    sourceState,
    sourceProgressSegments,
    displaySet,
    targetSet,
    saucenaoReady,
    credentialsState,
    credentialLastProvider,
    credentialInputs,
    credentialExpanded,
    toggleDisplaySource,
    toggleTargetSource,
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
    cancelFavoritesSync,
    booruDevOptions,
    setBooruDevOptionsPersistent
  };

  return {
    sourceSettingsProps,
    favoritesAccountsProps,
    sourceSettings,
    favoritesRootSettings,
    favoritesRootSettingsState,
    updateFavoritesRoot
  };
}
