import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/api';
import { queryKeys } from '@/lib/query-keys';

export function useFileTags(
  fileId: string | null,
  options: { enabled?: boolean } = {}
) {
  return useQuery({
    queryKey: queryKeys.files.tags(fileId ?? ''),
    queryFn: () => api.getFileTags(fileId as string),
    enabled: Boolean(fileId) && (options.enabled ?? true)
  });
}

export function useRefreshFileTags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => api.refreshFileTags(fileId),
    onSuccess: (_data, fileId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.files.tags(fileId) });
    }
  });
}

export function useClearFileTags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => api.clearFileTags(fileId),
    onSuccess: (_data, fileId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.files.tags(fileId) });
    }
  });
}

export function useAddManualTag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      fileId,
      tag,
      category
    }: {
      fileId: string;
      tag: string;
      category: string;
    }) => api.addManualTag(fileId, tag, category),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.tags(variables.fileId)
      });
    }
  });
}

export function useSuppressFileTags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ fileId, tags }: { fileId: string; tags: string[] }) =>
      api.suppressFileTags(fileId, tags),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.tags(variables.fileId)
      });
      // A removed tag changes which files the gallery filter matches.
      queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
    }
  });
}

export function useRemoveTopMatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      fileId,
      sourceUrl
    }: {
      fileId: string;
      sourceUrl: string;
    }) => api.removeTopMatch(fileId, sourceUrl),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.providers(variables.fileId)
      });
    }
  });
}
