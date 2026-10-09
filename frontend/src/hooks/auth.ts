import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient
} from '@tanstack/react-query';

import { api, type AuthUser } from '@/api';
import { queryKeys } from '@/lib/query-keys';

export function useCurrentUser() {
  return useQuery<AuthUser | null>({
    queryKey: queryKeys.auth.me(),
    queryFn: async () => {
      try {
        return await api.getCurrentUser();
      } catch {
        return null;
      }
    },
    staleTime: 60_000
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { username: string; password: string }) => api.login(payload),
    onSuccess: (user) => {
      queryClient.setQueryData(queryKeys.auth.me(), user);
    }
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { username: string; password: string }) => api.register(payload),
    onSuccess: (user) => {
      queryClient.setQueryData(queryKeys.auth.me(), user);
    }
  });
}

/**
 * Forgets everything cached for the signed-out user, so the next account
 * on this browser never sees their settings or reports. The auth query is
 * set to null rather than removed: its observers must see the change.
 */
export function clearSignedOutQueries(queryClient: QueryClient) {
  queryClient.setQueryData(queryKeys.auth.me(), null);
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== queryKeys.auth.all[0]
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    // The app leaves for the login page even when the request fails, so the
    // cache goes either way.
    onSettled: () => {
      clearSignedOutQueries(queryClient);
    }
  });
}
