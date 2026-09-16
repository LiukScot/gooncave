import { useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { PoolHeaderActions } from './PoolHeaderActions';
import { readPoolSnapshot, writePoolSnapshot } from './poolSnapshot';
import { PoolTile } from './PoolTile';

import { api, type PoolPage, type PoolPagePost } from '@/api';
import { useOpenPoolPage } from '@/features/explore/useOpenBooruPost';
import { restoreScrollTo } from '@/features/file-detail/restoreScrollTo';

/**
 * One pool, first page to last, in the booru's reading order.
 *
 * Deliberately not the explore grid: there is nothing to sort, nothing to
 * filter and no second site to merge in — the order is the whole point, and
 * bending the explore controller around that would cost more than this does.
 */
export function PoolView() {
  const { site, pool } = useSearch({ from: '/app/pool' });
  return <PoolContent key={`${site}:${pool}`} site={site} pool={pool} />;
}

function PoolContent({ site, pool }: { site: string; pool: string }) {
  const [saved] = useState(() => readPoolSnapshot(site, pool));
  const [pages, setPages] = useState<PoolPage[]>(() => saved?.pages ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openPoolPage = useOpenPoolPage();
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const scrollRef = useRef(saved?.scrollY ?? 0);
  const leavingForDetailRef = useRef(false);

  useEffect(() => {
    const onScroll = () => {
      if (!leavingForDetailRef.current) scrollRef.current = window.scrollY;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!saved?.pages.length) return;
    return restoreScrollTo(saved.scrollY);
  }, [saved]);

  useEffect(() => () => {
    if (!pagesRef.current.length) return;
    writePoolSnapshot({
      siteId: site,
      poolId: pool,
      pages: pagesRef.current,
      scrollY: scrollRef.current
    });
  }, [site, pool]);

  const loadPage = useCallback(
    async (page: number, signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.poolPage(site, pool, page, signal);
        if (signal?.aborted) return;
        setPages((current) =>
          // Re-entering the same page (a double click on Load more) must not
          // show it twice.
          current.some((entry) => entry.page === result.page)
            ? current
            : [...current, result]
        );
      } catch (err) {
        if (!signal?.aborted) setError((err as Error).message);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [site, pool]
  );

  useEffect(() => {
    if (saved?.pages.length) return;
    setPages([]);
    const controller = new AbortController();
    void loadPage(1, controller.signal);
    return () => controller.abort();
  }, [loadPage, saved]);

  const head = pages[0];
  const posts = pages.flatMap((entry) => entry.posts);
  const hasMore = head ? posts.length < head.postCount : false;

  const openPage = (post: PoolPagePost) => {
    if (!head) return;
    scrollRef.current = window.scrollY;
    leavingForDetailRef.current = true;
    openPoolPage(
      { siteId: site, poolId: pool, postIds: head.postIds },
      posts,
      post
    );
  };

  return (
    <div className="page-chrome">
      <div className="pool-head">
        <div>
          <h1 className="uppercase font-semibold file-detail-section-title mb-1">
            {head ? head.name : 'Pool'}
          </h1>
          <div className="text-muted-foreground text-sm">
            {head
              ? `${head.postCount} posts on ${head.siteName}`
              : loading
                ? 'Loading…'
                : ''}
          </div>
        </div>
        {/* Phone only: on a wide screen these sit in the shell's header, on
            the line with Explore and Gallery. */}
        <div className="md:hidden">
          <PoolHeaderActions />
        </div>
      </div>
      {error ? (
        <div className="text-destructive text-sm mb-2">{error}</div>
      ) : null}
      <div className="pool-grid">
        {posts.map((post) => (
          <PoolTile
            key={post.remoteId}
            post={post}
            onOpen={() => openPage(post)}
          />
        ))}
      </div>
      {hasMore ? (
        <div className="flex justify-center mt-4">
          <button
            type="button"
            className="btn btn-outline-light btn-sm"
            disabled={loading}
            onClick={() => void loadPage(pages.length + 1)}
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
