import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';

import { subscriptionActionState } from './subscriptionFeed';

import { api } from '@/api';
import type { ChoiceAction } from '@/components/confirm-dialog';
import { normalizeTag } from '@/features/settings/blacklist';
import {
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
  const subscriptionTags = useSubscriptionTags();
  const { mutateAsync: addTag } = useAddSubscriptionTag();
  const { mutateAsync: saveTags } = useUpdateSubscriptionTags();
  const blacklist = useBlacklistSettings();
  const { mutateAsync: saveBlacklist } = useUpdateBlacklistSettings();
  const subscribedTags = useMemo(
    () => subscriptionTags.data?.tags ?? [],
    [subscriptionTags.data?.tags]
  );

  const actionFor = useCallback(
    (tag: string): ChoiceAction<TagSubscriptionMode> => {
      const state = subscriptionActionState(tag, subscribedTags);
      return {
        value: state.subscribed ? 'unsubscribe' : 'subscribe',
        label: state.label,
        variant: state.subscribed ? 'destructive' : 'default'
      };
    },
    [subscribedTags]
  );

  const runAction = useCallback(
    async (mode: TagSubscriptionMode, tag: string) => {
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
        if (mode === 'subscribe') {
          await addTag(tag);
          toast.success(`Subscribed to ${tag}`);
          return;
        }
        const normalizedTag = normalizeTag(tag);
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
    [addTag, saveBlacklist, saveTags, subscribedTags]
  );

  const blacklistActionFor = useCallback(
    (tag: string): ChoiceAction<TagSubscriptionMode> => {
      const included = blacklist.tags.includes(normalizeTag(tag));
      return {
        value: included ? 'unblacklist' : 'blacklist',
        label: included ? 'Remove from blacklist' : 'Add to blacklist',
        variant: included ? 'default' : 'destructive'
      };
    },
    [blacklist.tags]
  );

  return { actionFor, blacklistActionFor, runAction };
}
