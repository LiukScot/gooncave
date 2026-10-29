import { useQuery } from '@tanstack/react-query';

import { api, type FileSiteInfo } from '@/api';
import { queryKeys } from '@/lib/query-keys';

// Read from the local database, and only changed by a sync, so a long wait is safe.
const STALE_MS = 60 * 60 * 1000;

/** What the booru said about the post a library file was saved from, or null. */
export const useFileSiteInfo = (fileId: string): FileSiteInfo | null => {
  const { data } = useQuery({
    queryKey: queryKeys.files.siteInfo(fileId),
    queryFn: () => api.getFileSiteInfo(fileId),
    staleTime: STALE_MS
  });
  return data?.info ?? null;
};
