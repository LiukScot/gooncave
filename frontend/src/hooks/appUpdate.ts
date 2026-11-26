import { useQuery } from '@tanstack/react-query';

import { api } from '@/api';
import { queryKeys } from '@/lib/query-keys';

/** The core asks GitHub at most once a day; once per launch is enough here. */
export function useAppUpdate() {
  return useQuery({
    queryKey: queryKeys.appUpdate,
    queryFn: api.getAppUpdate,
    staleTime: Infinity,
    retry: false
  });
}
