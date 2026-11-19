import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { api } from '@/api';
import { queryKeys } from '@/lib/query-keys';

/** How many searches Explore remembers; the core refuses a longer list. */
export const RECENT_SEARCH_LIMIT = 20;

/** `list` with `search` moved to the front, without repeats and within the limit. */
export function withRecentSearch(list: readonly string[], search: string): string[] {
  const trimmed = search.trim();
  if (!trimmed) return [...list];
  return [trimmed, ...list.filter((entry) => entry !== trimmed)].slice(0, RECENT_SEARCH_LIMIT);
}

export function useRecentSearches(): string[] {
  const { data } = useQuery({
    queryKey: queryKeys.settings.recentSearches(),
    queryFn: () => api.getRecentSearches(),
    staleTime: 60_000
  });
  return data ?? [];
}

/** Puts a search at the top of the recent searches. */
export function useRememberSearch(): (search: string) => void {
  const queryClient = useQueryClient();
  const { mutate } = useMutation({
    mutationFn: (list: string[]) => api.setRecentSearches(list),
    onSuccess: (list) => queryClient.setQueryData(queryKeys.settings.recentSearches(), list),
    onError: (error) => console.error('[developer] Explore could not save a recent search:', error)
  });
  return useCallback(
    (search: string) => {
      const key = queryKeys.settings.recentSearches();
      const current = queryClient.getQueryData<string[]>(key) ?? [];
      const next = withRecentSearch(current, search);
      if (next[0] === current[0] && next.length === current.length) return;
      queryClient.setQueryData(key, next);
      mutate(next);
    },
    [mutate, queryClient]
  );
}
