import { useCallback } from 'react';
import { toast } from 'sonner';

import { postLinkTarget } from './postLink';

import { api, type LibraryAwarePost } from '@/api';
import { useBooruSites } from '@/hooks/booru-sites';

/**
 * Turns a search box's text into a post when it is a link to one on an enabled site.
 * Returns `search` when the text is a search, `opened` when it is such a link (the post is
 * fetched and handed to `open`), and `waiting` for any link while the sites load: the caller
 * keeps it and asks again once they arrive, rather than searching it as a tag.
 */
export const useOpenPostLink = (
  open: (post: LibraryAwarePost) => void
): ((value: string) => 'search' | 'opened' | 'waiting') => {
  const sites = useBooruSites().data;
  return useCallback(
    (value: string): 'search' | 'opened' | 'waiting' => {
      const text = value.trim();
      if (!sites) return /^https?:\/\//i.test(text) ? 'waiting' : 'search';
      const target = postLinkTarget(
        text,
        sites.filter((site) => site.enabled)
      );
      if (!target) return 'search';
      api
        .explorePost(target.siteId, target.remoteId)
        .then(({ post }) => open(post))
        .catch((error: unknown) => {
          console.error('[developer] Opening a searched post link failed', error);
          toast.error(
            `Could not open that post: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      return 'opened';
    },
    [open, sites]
  );
};
