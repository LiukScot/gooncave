import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type SourceSettings } from '@/api';
import { queryKeys } from '@/lib/query-keys';

export function useSources(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.sources.list(),
    queryFn: () => api.getSources(),
    enabled: options.enabled ?? true
  });
}

export function useUpdateSourceSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: SourceSettings) => api.updateSourceSettings(settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sources.list() });
    }
  });
}
