import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/**
 * Puts `search` at the top of the recent searches and hands the new list to `save`. The list is
 * read from the core first when it has not loaded yet: saving a list built on nothing would
 * replace the one shared between devices.
 */
export async function rememberSearchIn(
  queryClient: QueryClient,
  search: string,
  save: (list: string[]) => void
): Promise<void> {
  const key = queryKeys.settings.recentSearches();
  const loaded = await queryClient.ensureQueryData({ queryKey: key, queryFn: () => api.getRecentSearches() });
  // Another search may have been added while the list loaded.
  const current = queryClient.getQueryData<string[]>(key) ?? loaded;
  const next = withRecentSearch(current, search);
  if (next[0] === current[0] && next.length === current.length) return;
  queryClient.setQueryData(key, next);
  save(next);
}

/** Puts a search at the top of the recent searches. */
export function useRememberSearch(): (search: string) => void {
  const queryClient = useQueryClient();
  const { mutate } = useMutation({
    mutationFn: (list: string[]) => api.setRecentSearches(list),
    // The new list is already shown; an answer arriving late must not put an older one back.
    onError: (error) => {
      console.error('[developer] Explore could not save a recent search:', error);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.recentSearches() });
    }
  });
  return useCallback(
    (search: string) => {
      rememberSearchIn(queryClient, search, mutate).catch((error: unknown) => {
        console.error('[developer] Explore could not read the recent searches, so this one was not saved:', error);
      });
    },
    [mutate, queryClient]
  );
}
