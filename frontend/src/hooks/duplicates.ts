import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type DuplicateScanOptions } from '@/api';
import { queryKeys } from '@/lib/query-keys';

type ScanStatusOptions = {
  enabled?: boolean;
  refetchInterval?: number | false;
};

export function useDuplicateScanStatus(options: ScanStatusOptions = {}) {
  return useQuery({
    queryKey: queryKeys.duplicates.scanStatus(),
    queryFn: () => api.getDuplicateScanStatus(),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval
  });
}

export function useStartDuplicateScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (options?: DuplicateScanOptions) => api.startDuplicateScan(options),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.duplicates.scanStatus() });
    }
  });
}

export function useCancelDuplicateScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelDuplicateScan(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.duplicates.scanStatus() });
    }
  });
}

export function useDuplicateSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.duplicates.settings(),
    queryFn: () => api.getDuplicateSettings(),
    enabled: options.enabled ?? true
  });
}

export function useUpdateDuplicateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: { enabled: false }) =>
      api.updateDuplicateSettings(settings),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.duplicates.settings(), settings);
      queryClient.invalidateQueries({ queryKey: queryKeys.duplicates.settings() });
    }
  });
}

export function useDuplicatePolicyStatus(
  options: { enabled?: boolean; watch?: boolean } = {}
) {
  return useQuery({
    queryKey: queryKeys.duplicates.policyStatus(),
    queryFn: () => api.getDuplicatePolicyStatus(),
    enabled: options.enabled ?? true,
    refetchInterval: (query) =>
      query.state.data?.latestRun?.status === 'running'
        ? 800
        : options.watch
          ? 5_000
          : false
  });
}

export function usePreviewDuplicatePolicy() {
  return useMutation({ mutationFn: api.previewDuplicatePolicy });
}

export function useConfirmDuplicatePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.confirmDuplicatePolicy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.duplicates.settings() });
      queryClient.invalidateQueries({ queryKey: queryKeys.duplicates.policyStatus() });
    }
  });
}

export function useRetryDuplicatePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.retryDuplicatePolicy(),
    onSuccess: () => {
      globalThis.setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: queryKeys.duplicates.policyStatus() });
      }, 1800);
    }
  });
}
