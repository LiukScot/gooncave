import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.setQueryData(queryKeys.auth.me(), null);
      queryClient.removeQueries({ queryKey: queryKeys.folders.all });
      queryClient.removeQueries({ queryKey: queryKeys.files.all });
      queryClient.removeQueries({ queryKey: queryKeys.sauces.all });
      queryClient.removeQueries({ queryKey: queryKeys.favorites.all });
      queryClient.removeQueries({ queryKey: queryKeys.credentials.all });
      queryClient.removeQueries({ queryKey: queryKeys.duplicates.all });
      queryClient.removeQueries({ queryKey: queryKeys.booruSites.all });
    }
  });
}
