import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from '@/api';
import { queryKeys } from '@/lib/query-keys';

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
