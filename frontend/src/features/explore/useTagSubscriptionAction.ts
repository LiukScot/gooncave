import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';

import { subscriptionActionState } from './subscriptionFeed';

import type { ChoiceAction } from '@/components/confirm-dialog';
import { normalizeTag } from '@/features/settings/blacklist';
import {
  useAddSubscriptionTag,
  useSubscriptionTags,
  useUpdateSubscriptionTags
} from '@/hooks/settings';

export type TagSubscriptionMode = 'subscribe' | 'unsubscribe';

/**
 * The Subscribe / Remove subscription entry of a tag pill's action dialog,
 * shared by every view that shows tag pills. `runAction` reports the outcome
 * as a toast and never throws.
 */
export function useTagSubscriptionAction() {
  const subscriptionTags = useSubscriptionTags();
  const { mutateAsync: addTag } = useAddSubscriptionTag();
  const { mutateAsync: saveTags } = useUpdateSubscriptionTags();
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
    [addTag, saveTags, subscribedTags]
  );

  return { actionFor, runAction };
}
