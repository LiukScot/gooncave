import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import {
  DEFAULT_SHORTCUTS,
  normaliseBindings,
  withShortcutHint,
  type ShortcutAction,
  type ShortcutBindings
} from './shortcuts';

import { api } from '@/api';
import { queryKeys } from '@/lib/query-keys';

/**
 * The user's key bindings, filled out with the defaults. Kept on the server
 * so they follow the account rather than the browser.
 */
export function useShortcuts(): ShortcutBindings {
  const { data } = useQuery({
    queryKey: queryKeys.settings.shortcuts(),
    queryFn: () => api.getShortcuts(),
    staleTime: 60_000
  });
  return data ? normaliseBindings(data.bindings) : DEFAULT_SHORTCUTS;
}

export function useUpdateShortcuts() {
  const queryClient = useQueryClient();
  // Chained one at a time, like the extra-settings toggles. Each PUT
  // replaces the whole bindings blob, so two saves in flight together would
  // let whichever the server handled last win — remapping two keys quickly
  // would silently drop one of them.
  const pendingRef = useRef<Promise<unknown>>(Promise.resolve());
  return useMutation({
    mutationFn: (bindings: ShortcutBindings) => {
      const settled = pendingRef.current
        .catch(() => undefined)
        .then(() => api.updateShortcuts(bindings));
      pendingRef.current = settled;
      return settled;
    },
    // Applied straight away: a settings row that only shows the new key
    // after a round-trip reads as a rejected keystroke.
    onMutate: async (bindings) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.settings.shortcuts()
      });
      const previous = queryClient.getQueryData(
        queryKeys.settings.shortcuts()
      ) as { bindings: Record<string, string> } | undefined;
      queryClient.setQueryData(queryKeys.settings.shortcuts(), { bindings });
      return { previous };
    },
    onError: (_error, _bindings, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          queryKeys.settings.shortcuts(),
          context.previous
        );
      }
    },
    onSuccess: (response) => {
      queryClient.setQueryData(queryKeys.settings.shortcuts(), response);
    },
    // Two saves in quick succession each snapshot a cache already holding
    // the other's optimistic patch, so a rollback can leave the cache
    // disagreeing with the server. One refetch once everything settles
    // makes the server the last word.
    onSettled: () => {
      // fire and forget: the write is done, nothing waits on the refetch.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.settings.shortcuts()
      });
    }
  });
}

/** `Vote up (+)` for a tooltip, built from the live binding. */
export const shortcutHintFor = (
  bindings: ShortcutBindings,
  action: ShortcutAction,
  label: string
): string => withShortcutHint(label, bindings[action]);
