import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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
  return useMutation({
    mutationFn: (bindings: ShortcutBindings) => api.updateShortcuts(bindings),
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
    }
  });
}

/** `Vote up (+)` for a tooltip, built from the live binding. */
export const shortcutHintFor = (
  bindings: ShortcutBindings,
  action: ShortcutAction,
  label: string
): string => withShortcutHint(label, bindings[action]);
