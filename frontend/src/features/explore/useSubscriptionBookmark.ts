import { useCallback, useEffect, useRef } from 'react';

import { notifyActionError } from './actionToast';

import { api, type ExplorePost } from '@/api';

type Bookmark = { siteId: string; remoteId: string };

export const visibleSubscriptionPost = (
  cards: Array<{ key: string; top: number; bottom: number }>,
  posts: ExplorePost[],
  viewportHeight: number
): ExplorePost | undefined => {
  const card = cards.filter(({ top, bottom }) => bottom > 0 && top < viewportHeight)
    .sort((a, b) => Math.abs(a.top) - Math.abs(b.top))[0];
  return card ? posts.find((post) => `${post.siteId}:${post.remoteId}` === card.key) : undefined;
};

export function useSubscriptionBookmark(enabled: boolean, posts: ExplorePost[], selected: ExplorePost | null) {
  const latest = useRef({ enabled, posts, selected });
  latest.current = { enabled, posts, selected };
  const pending = useRef<Bookmark | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const clearing = useRef(false);
  const savedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      const current = latest.current;
      if (!current.enabled || clearing.current) return;
      const visible = current.selected ?? visibleSubscriptionPost(
        [...document.querySelectorAll<HTMLElement>('[data-read-key]')].map((card) => ({
          key: card.dataset.readKey ?? '',
          top: card.getBoundingClientRect().top,
          bottom: card.getBoundingClientRect().bottom
        })),
        current.posts,
        window.innerHeight
      );
      if (!visible || !current.posts.some((post) => post.siteId === visible.siteId && post.remoteId === visible.remoteId)) return;
      const key = `${visible.siteId}:${visible.remoteId}`;
      if (savedKey.current === key) return;
      pending.current = { siteId: visible.siteId, remoteId: visible.remoteId };
      if (running.current) return;
      // Finish the final small write on navigation; keepalive also covers closing the window.
      running.current = (async () => {
        while (pending.current) {
          const bookmark = pending.current;
          pending.current = null;
          await api.saveSubscriptionBookmark(bookmark);
          savedKey.current = `${bookmark.siteId}:${bookmark.remoteId}`;
        }
      })().catch((error: unknown) => {
        pending.current = null;
        notifyActionError('Could not save your place in Subscribed', error);
      }).finally(() => { running.current = null; });
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(save, 500);
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('pagehide', save);
    schedule();
    return () => {
      clearTimeout(timer);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('pagehide', save);
    };
  }, [enabled, selected, posts]);
  return useCallback(async () => {
    clearing.current = true;
    pending.current = null;
    try {
      await running.current;
      await api.clearSubscriptionBookmark();
      savedKey.current = null;
    } finally {
      clearing.current = false;
    }
  }, []);
}
