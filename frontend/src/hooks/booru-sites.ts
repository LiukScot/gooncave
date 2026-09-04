import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type BooruEngineType, type BooruSite } from '@/api';
import { queryKeys } from '@/lib/query-keys';

type BooruCreatePayload = Parameters<typeof api.createBooruSite>[0];
type BooruUpdatePayload = Parameters<typeof api.updateBooruSite>[1];

export function useBooruSites(options: { enabled?: boolean } = {}) {
  return useQuery<BooruSite[]>({
    queryKey: queryKeys.booruSites.list(),
    queryFn: () => api.getBooruSites(),
    enabled: options.enabled ?? true
  });
}

export function useBooruEngineCatalog(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.booruSites.engineCatalog(),
    queryFn: () => api.getBooruEngineCatalog(),
    enabled: options.enabled ?? true,
    staleTime: 5 * 60_000
  });
}

export function useDetectBooruEngine() {
  return useMutation({
    mutationFn: (baseUrl: string) => api.detectBooruEngine(baseUrl)
  });
}

export function useCreateBooruSite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: BooruCreatePayload) => api.createBooruSite(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.booruSites.list() });
    }
  });
}

export function useUpdateBooruSite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: BooruUpdatePayload }) =>
      api.updateBooruSite(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.booruSites.list() });
    }
  });
}

export function useDeleteBooruSite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteBooruSite(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.booruSites.list() });
    }
  });
}

/** Live progress of a tag re-read; only polled while one is running. */
export function useBooruTagRefresh(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.booruSites.tagRefresh(),
    queryFn: () => api.getBooruTagRefresh(),
    refetchInterval: enabled ? 2_000 : false
  });
}

export function useStartBooruTagRefresh() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.refreshBooruSiteTags(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.booruSites.tagRefresh()
      });
    }
  });
}

export function useCancelBooruTagRefresh() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelBooruTagRefresh(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.booruSites.tagRefresh()
      });
    }
  });
}

export function useTestBooruSite() {
  return useMutation({
    mutationFn: (id: string) => api.testBooruSite(id)
  });
}

export function useReorderBooruSites() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: string[]) => api.reorderBooruSites(orderedIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.booruSites.list() });
    }
  });
}

export type { BooruEngineType };
