import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ProviderRun } from '@/api';
import { queryKeys } from '@/lib/query-keys';

type FilesParams = {
  folderId?: string;
  sort?: 'mtime_desc' | 'mtime_asc' | 'random' | 'manual';
  tags?: string;
  mediaType?: 'IMAGE' | 'VIDEO';
  favoritesOnly?: boolean;
  seed?: string;
  offset?: number;
  limit?: number;
};

export function useFiles(params: FilesParams, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.files.list(params),
    queryFn: ({ signal }) =>
      api.getFiles(params.folderId, params.sort, params.tags, {
        limit: params.limit,
        offset: params.offset,
        seed: params.seed,
        mediaType: params.mediaType,
        favoritesOnly: params.favoritesOnly,
        signal
      }),
    enabled: options.enabled ?? true,
    placeholderData: (previous) => previous
  });
}

export function useFileProviders(fileId: string | null) {
  return useQuery({
    queryKey: queryKeys.files.providers(fileId ?? ''),
    queryFn: () => api.getProviders(fileId as string),
    enabled: Boolean(fileId)
  });
}

export function useDeleteFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => api.deleteFile(fileId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.duplicates.all });
    }
  });
}

export function useUpdateFileFavorite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ fileId, favorite }: { fileId: string; favorite: boolean }) =>
      api.updateFileFavorite(fileId, favorite),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.favorites.all });
    }
  });
}

export function useRunProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ fileId, provider }: { fileId: string; provider: 'saucenao' | 'fluffle' }) =>
      api.runProvider(fileId, provider),
    onSuccess: (_data: { runs: ProviderRun[] }, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.files.providers(variables.fileId) });
    }
  });
}

export function useUpdateManualOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (order: string[]) => api.updateManualOrder(order),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
    }
  });
}
