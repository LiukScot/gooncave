import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type DuplicateScanOptions, type DuplicateSettings } from '@/api';
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
    mutationFn: (settings: Partial<DuplicateSettings>) =>
      api.updateDuplicateSettings(settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.duplicates.settings() });
    }
  });
}
