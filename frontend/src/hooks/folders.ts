import { useQuery } from '@tanstack/react-query';

import { api, type Folder } from '@/api';
import { queryKeys } from '@/lib/query-keys';

export function useFolders(options: { enabled?: boolean; refetchInterval?: number | false } = {}) {
  return useQuery<Folder[]>({
    queryKey: queryKeys.folders.list(),
    queryFn: () => api.getFolders(),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval ?? false
  });
}
