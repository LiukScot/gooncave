import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type Folder } from '@/api';
import { queryKeys } from '@/lib/query-keys';

export function useFolders(options: { enabled?: boolean } = {}) {
  return useQuery<Folder[]>({
    queryKey: queryKeys.folders.list(),
    queryFn: () => api.getFolders(),
    enabled: options.enabled ?? true
  });
}

export function useDeleteFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteFolder(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.folders.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
    }
  });
}

type UploadVariables = {
  folderId: string;
  files: File[];
  onProgress?: Parameters<typeof api.uploadFolderFiles>[2] extends infer Opt
    ? Opt extends { onProgress?: infer F }
      ? F
      : never
    : never;
};

export function useUploadFolderFiles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ folderId, files, onProgress }: UploadVariables) =>
      api.uploadFolderFiles(folderId, files, onProgress ? { onProgress } : undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.files.all });
    }
  });
}
