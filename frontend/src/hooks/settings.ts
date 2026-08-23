import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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
  return useMutation({
    mutationFn: (patch: Partial<ExtraSettings>) =>
      api.updateExtraSettings(patch),
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
