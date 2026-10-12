import { useQuery } from '@tanstack/react-query';

import { api } from '@/api';
import { queryKeys } from '@/lib/query-keys';

export function useDeviceProfile() {
  return useQuery({
    queryKey: queryKeys.device,
    queryFn: api.getDeviceProfile,
    staleTime: Infinity,
    retry: false
  });
}
