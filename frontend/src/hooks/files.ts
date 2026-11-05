import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/api';
import { queryKeys } from '@/lib/query-keys';

// Short enough that a change made elsewhere (a sync, a job, another screen) shows before the
// reader wonders; the request is a single number.
const LIBRARY_VERSION_POLL_MS = 3000;

/** A number the core changes on every write the gallery shows; polled while `enabled`. */
export function useLibraryVersion(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.files.libraryVersion(),
    queryFn: api.getLibraryVersion,
    enabled,
    refetchInterval: LIBRARY_VERSION_POLL_MS
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
    mutationFn: (fileId: string) => api.voteFile(fileId),
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
