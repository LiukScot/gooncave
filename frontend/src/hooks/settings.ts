import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import { api, EXTRA_SETTINGS_DEFAULTS, type ExtraSettings } from '@/api';
import { queryKeys } from '@/lib/query-keys';

/** Extra-feature toggles, falling back to the defaults while loading. */
export function useExtraSettings(): ExtraSettings {
  const { data } = useQuery({
    queryKey: queryKeys.settings.extra(),
    queryFn: () => api.getExtraSettings(),
    staleTime: 60_000
  });
  return data ?? EXTRA_SETTINGS_DEFAULTS;
}

export function useUpdateExtraSettings() {
  const queryClient = useQueryClient();
  // Requests leave one at a time, chained onto the previous one. Flipping the
  // same toggle twice in quick succession would otherwise put two writes for
  // one key in flight together, and whichever the server happened to handle
  // last would win — losing the user's final choice rather than just
  // disagreeing with the cache. The UI stays responsive because the optimistic
  // patch below has already applied.
  const pendingRef = useRef<Promise<unknown>>(Promise.resolve());
  return useMutation({
    mutationFn: (patch: Partial<ExtraSettings>) => {
      const settled = pendingRef.current
        .catch(() => undefined)
        .then(() => api.updateExtraSettings(patch));
      pendingRef.current = settled;
      return settled;
    },
    // Applied optimistically: these toggles add and remove whole chunks of
    // navigation, and a checkbox that only moves after a round-trip reads
    // as broken.
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.settings.extra() });
      const previous =
        queryClient.getQueryData<ExtraSettings>(queryKeys.settings.extra()) ??
        EXTRA_SETTINGS_DEFAULTS;
      queryClient.setQueryData(queryKeys.settings.extra(), {
        ...previous,
        ...patch
      });
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context) {
        queryClient.setQueryData(queryKeys.settings.extra(), context.previous);
      }
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.settings.extra(), settings);
    },
    // Two toggles in quick succession each snapshot a cache that already
    // holds the other's optimistic patch, so a rollback can leave the cache
    // disagreeing with the server. Refetching once everything settles makes
    // the server the last word.
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.settings.extra()
      });
    }
  });
}
