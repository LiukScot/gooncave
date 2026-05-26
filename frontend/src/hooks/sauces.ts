import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type SauceSettings } from '@/api';
import { queryKeys } from '@/lib/query-keys';

export function useSauces(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.sauces.list(),
    queryFn: () => api.getSauces(),
    enabled: options.enabled ?? true
  });
}

export function useUpdateSauceSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: SauceSettings) => api.updateSauceSettings(settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sauces.list() });
    }
  });
}
