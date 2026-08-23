import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions
} from '@tanstack/react-query';

import { api, type FavoriteSyncStatus } from '@/api';
import { queryKeys } from '@/lib/query-keys';

type SyncStatusOptions = {
  enabled?: boolean;
  /** Bound to the query's own data type: reading it off a generic-less
      useQuery collapsed the whole options object, and with it the inferred
      shape of the data every caller reads. */
  refetchInterval?: UseQueryOptions<FavoriteSyncStatus>['refetchInterval'];
};

export function useFavoritesSyncStatus(options: SyncStatusOptions = {}) {
  return useQuery({
    queryKey: queryKeys.favorites.syncStatus(),
    queryFn: () => api.getFavoritesSyncStatus(),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval
  });
}

export function useSyncFavorites() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload?: { providers?: string[]; deleteMissing?: boolean }) =>
      api.syncFavorites(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.favorites.syncStatus()
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
    }
  });
}

export function useFavoritesSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.favorites.settings(),
    queryFn: () => api.getFavoritesSettings(),
    enabled: options.enabled ?? true
  });
}

export function useUpdateFavoritesSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: Parameters<typeof api.updateFavoritesSettings>[0]) =>
      api.updateFavoritesSettings(settings),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.favorites.settings()
      });
    }
  });
}
