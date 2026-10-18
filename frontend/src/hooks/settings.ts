import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import {
  api,
  BLACKLIST_DEFAULTS,
  EXTRA_SETTINGS_DEFAULTS,
  type BlacklistSettings,
  type ExtraSettings,
  type PoolSubscription,
  type SubscriptionSettings
} from '@/api';
import { writeExploreSnapshot } from '@/features/explore/exploreSnapshot';
import { useDeviceProfile } from '@/hooks/device';
import { queryKeys } from '@/lib/query-keys';

/** Extra-feature toggles, plus whether the persisted values have loaded. */
export function useExtraSettings(): ExtraSettings & { loaded: boolean } {
  const { data } = useQuery({
    queryKey: queryKeys.settings.extra(),
    queryFn: () => api.getExtraSettings(),
    staleTime: 60_000
  });
  return { ...(data ?? EXTRA_SETTINGS_DEFAULTS), loaded: data !== undefined };
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
      // fire and forget: the write is already done, the refetch only
      // reconciles the cache and nothing waits on it.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.settings.extra()
      });
    }
  });
}

/**
 * The tag blacklist, falling back to the defaults while loading. `loaded`
 * says whether those are the real settings: a list that arrives after the
 * first page of results has already been fetched would show exactly the
 * posts it exists to hide, so callers wait for it.
 */
export function useBlacklistSettings(): BlacklistSettings & {
  loaded: boolean;
} {
  const { data } = useQuery({
    queryKey: queryKeys.settings.blacklist(),
    queryFn: () => api.getBlacklist(),
    staleTime: 60_000
  });
  return { ...(data ?? BLACKLIST_DEFAULTS), loaded: data !== undefined };
}

export function useUpdateBlacklistSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<BlacklistSettings>) =>
      api.updateBlacklist(patch),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.settings.blacklist(), settings);
    }
  });
}

export function useSubscriptions(options: { enabled?: boolean } = {}) {
  return useQuery<SubscriptionSettings>({
    queryKey: queryKeys.settings.subscriptions(),
    queryFn: () => api.getSubscriptions(),
    staleTime: 30_000,
    enabled: options.enabled ?? true
  });
}

export function useSubscriptionTags(options: { enabled?: boolean } = {}) {
  // Subscriptions live on boorus; a core without them has none to read.
  const capabilities = useDeviceProfile().data?.capabilities;
  const boorusAvailable = capabilities?.subscriptions !== false && capabilities?.boorus !== false;
  return useQuery<{ tags: string[] }>({
    queryKey: queryKeys.settings.subscriptionTags(),
    queryFn: () => api.getSubscriptionTags(),
    staleTime: 30_000,
    enabled: (options.enabled ?? true) && boorusAvailable
  });
}

export const useAddSubscriptionTag = () => useAddSubscription(api.addSubscriptionTag);

function useAddSubscription(add: (value: string) => Promise<{ tags: string[] }>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: add,
    onSuccess: ({ tags }) => {
      writeExploreSnapshot(null);
      queryClient.setQueryData(queryKeys.settings.subscriptionTags(), { tags });
      queryClient.setQueryData<SubscriptionSettings>(
        queryKeys.settings.subscriptions(),
        (current) =>
          current
            ? {
                ...current,
                tags,
                targets: [
                  ...tags.map((value) => ({ kind: 'tag' as const, value })),
                  ...current.targets.filter((target) => target.kind === 'artist')
                ]
              }
            : undefined
      );
    }
  });
}

export function useUpdateSubscriptionTags() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tags: string[]) => api.updateSubscriptionTags(tags),
    onSuccess: ({ tags }) => {
      writeExploreSnapshot(null);
      queryClient.setQueryData(queryKeys.settings.subscriptionTags(), { tags });
      queryClient.setQueryData<SubscriptionSettings>(
        queryKeys.settings.subscriptions(),
        (current) =>
          current
            ? {
                ...current,
                tags,
                targets: [
                  ...tags.map((value) => ({ kind: 'tag' as const, value })),
                  ...current.targets.filter((target) => target.kind === 'artist')
                ]
              }
            : undefined
      );
    }
  });
}

export function useSubscriptionPools() {
  const capabilities = useDeviceProfile().data?.capabilities;
  const boorusAvailable = capabilities?.subscriptions !== false && capabilities?.boorus !== false;
  return useQuery<{ pools: PoolSubscription[] }>({
    queryKey: queryKeys.settings.subscriptionPools(),
    queryFn: () => api.getSubscriptionPools(),
    staleTime: 30_000,
    enabled: boorusAvailable
  });
}

/** Follows or unfollows one pool; the list is replaced by the server's. */
export function usePoolSubscriptionMutation(subscribed: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ siteId, poolId }: { siteId: string; poolId: string }) =>
      subscribed
        ? api.subscribePool(siteId, poolId)
        : api.unsubscribePool(siteId, poolId),
    onSuccess: (data) =>
      queryClient.setQueryData(queryKeys.settings.subscriptionPools(), data)
  });
}

export function useArtistSubscriptionMutation(subscribed: boolean) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ siteId, artist }: { siteId: string; artist: string }) =>
      subscribed
        ? api.subscribeArtist(siteId, artist)
        : api.unsubscribeArtist(siteId, artist),
    onSuccess: () => {
      writeExploreSnapshot(null);
      return queryClient.invalidateQueries({
        queryKey: queryKeys.settings.subscriptions()
      });
    }
  });
}
