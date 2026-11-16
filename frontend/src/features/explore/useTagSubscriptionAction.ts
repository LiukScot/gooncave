import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';

import { subscriptionActionState } from './subscriptionFeed';

import { api } from '@/api';
import type { ChoiceAction } from '@/components/confirm-dialog';
import { normalizeTag } from '@/features/settings/blacklist';
import { useDeviceProfile } from '@/hooks/device';
import {
  useArtistSubscriptionMutation,
  useBlacklistSettings,
  useAddSubscriptionTag,
  useSubscriptionTags,
  useUpdateBlacklistSettings,
  useUpdateSubscriptionTags
} from '@/hooks/settings';

export type TagSubscriptionMode =
  | 'subscribe'
  | 'unsubscribe'
  | 'blacklist'
  | 'unblacklist';

/**
 * Subscription and blacklist entries of a tag pill's action dialog,
 * shared by every view that shows tag pills. `runAction` reports the outcome
 * as a toast and never throws.
 */
export function useTagSubscriptionAction() {
  const subscriptionsAvailable = useDeviceProfile().data?.capabilities?.subscriptions !== false;
  const subscriptionTags = useSubscriptionTags();
  const { mutateAsync: addTag } = useAddSubscriptionTag();
  const { mutateAsync: saveTags } = useUpdateSubscriptionTags();
  const { mutateAsync: unfollowArtist } = useArtistSubscriptionMutation(false);
  const blacklist = useBlacklistSettings();
  const { mutateAsync: saveBlacklist } = useUpdateBlacklistSettings();
  const subscribedTags = useMemo(
    () => subscriptionTags.data?.tags ?? [],
    [subscriptionTags.data?.tags]
  );
  const followedArtists = useMemo(
    () => subscriptionTags.data?.artists ?? [],
    [subscriptionTags.data?.artists]
  );

  const actionFor = useCallback(
    (tag: string): ChoiceAction<TagSubscriptionMode> => {
      const state = subscriptionActionState(tag, [...subscribedTags, ...followedArtists]);
      return {
        value: state.subscribed ? 'unsubscribe' : 'subscribe',
        label: !subscriptionsAvailable ? 'Subscriptions unavailable' : state.label,
        variant: state.subscribed ? 'destructive' : 'default'
      };
    },
    [followedArtists, subscribedTags, subscriptionsAvailable]
  );

  /** `category` is the pill's: subscribing to an `artist` pill follows it as an artist, on any site. */
  const runAction = useCallback(
    async (mode: TagSubscriptionMode, tag: string, category?: string) => {
      try {
        if (mode === 'blacklist' || mode === 'unblacklist') {
          const normalizedTag = normalizeTag(tag);
          const current = await api.getBlacklist();
          await saveBlacklist({
            tags:
              mode === 'blacklist'
                ? Array.from(new Set([...current.tags, normalizedTag]))
                : current.tags.filter((entry) => entry !== normalizedTag)
          });
          toast.success(
            mode === 'blacklist'
              ? `Blacklisted ${tag}`
              : `Removed ${tag} from blacklist`
          );
          return;
        }
        if (!subscriptionsAvailable) {
          toast.error('Subscriptions are not available in this development build. You can still search or blacklist this tag.');
          return;
        }
        if (mode === 'subscribe') {
          await addTag({ tag, artist: category === 'artist' || undefined });
          toast.success(`Subscribed to ${tag}`);
          return;
        }
        const normalizedTag = normalizeTag(tag);
        const followed = followedArtists.find(
          (artist) => normalizeTag(artist) === normalizedTag
        );
        if (followed) {
          await unfollowArtist(followed);
          toast.success(`Removed subscription to ${tag}`);
          return;
        }
        await saveTags(
          subscribedTags.filter(
            (subscribedTag) => normalizeTag(subscribedTag) !== normalizedTag
          )
        );
        toast.success(`Removed subscription to ${tag}`);
      } catch (error) {
        toast.error((error as Error).message);
      }
    },
    [addTag, followedArtists, saveBlacklist, saveTags, subscribedTags, subscriptionsAvailable, unfollowArtist]
  );

  const blacklistActionFor = useCallback(
    (tag: string): ChoiceAction<TagSubscriptionMode> => {
      const included = blacklist.tags.includes(normalizeTag(tag));
      return {
        value: included ? 'unblacklist' : 'blacklist',
        label: included ? 'Remove from blacklist' : 'Add to blacklist',
        variant: included ? 'default' : 'destructive',
        separated: true
      };
    },
    [blacklist.tags]
  );

  return { actionFor, blacklistActionFor, runAction };
}
