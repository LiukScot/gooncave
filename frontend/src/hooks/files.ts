import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/api';
import { queryKeys } from '@/lib/query-keys';

type FilesParams = {
  folderId?: string;
  sort?: 'mtime_desc' | 'mtime_asc' | 'random' | 'rated';
  tags?: string;
  mediaType?: 'IMAGE' | 'VIDEO';
  seed?: string;
  offset?: number;
  limit?: number;
};

export function useFiles(
  params: FilesParams,
  options: { enabled?: boolean } = {}
) {
  return useQuery({
    queryKey: queryKeys.files.list(params),
    queryFn: ({ signal }) =>
      api.getFiles(params.folderId, params.sort, params.tags, {
        limit: params.limit,
        offset: params.offset,
        seed: params.seed,
        mediaType: params.mediaType,
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

export function useVoteFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ fileId, value }: { fileId: string; value: 1 | -1 }) =>
      api.voteFile(fileId, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
    }
  });
}

export function useRunProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      fileId,
      provider
    }: {
      fileId: string;
      provider: 'saucenao' | 'fluffle';
    }) => api.runProvider(fileId, provider),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.providers(variables.fileId)
      });
    }
  });
}
