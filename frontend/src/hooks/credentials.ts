import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type CredentialProvider } from '@/api';
import { queryKeys } from '@/lib/query-keys';

export function useCredentials(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.credentials.list(),
    queryFn: () => api.getCredentials(),
    enabled: options.enabled ?? true
  });
}

export function useUpdateCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      provider: CredentialProvider;
      username?: string;
      apiKey?: string;
    }) => api.updateCredential(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.credentials.list() });
    }
  });
}
