import { ChevronDown, ChevronUp, Heart, Play } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { ExploreDetailPanel } from './ExploreDetailPanel';
import { isVideoUrl } from './exploreMedia';
import { isCurrentPeriod, periodLabel } from './popularPeriod';
import { explorePostKey, useExploreController } from './useExploreController';

import type { ExplorePost, ExploreSort, ExploreWindow } from '@/api';
import { distributeIntoColumns } from '@/features/library/masonry';
import { TagSearchInput } from '@/features/library/TagSearchInput';

const THUMB_SIZE = 220;
const MIN_COLUMNS = 2;

const SORTS: { key: ExploreSort; label: string; comingSoon?: boolean }[] = [
  { key: 'hot', label: 'Hot' },
  { key: 'popular', label: 'Popular' },
  { key: 'new', label: 'New' },
  { key: 'subscribed', label: 'Subscribed', comingSoon: true }
];

const WINDOWS: ExploreWindow[] = ['day', 'week', 'month'];

/** Same measurement the gallery uses, so both grids break at the same widths. */
function useColumnCount() {
  const [columnCount, setColumnCount] = useState(MIN_COLUMNS);
  const measureRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const measure = (width: number) =>
      setColumnCount(Math.max(MIN_COLUMNS, Math.floor(width / THUMB_SIZE)));
    measure(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) =>
      measure(entry.contentRect.width)
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [columnCount, measureRef] as const;
}

export function ExploreView() {
  const ctl = useExploreController();
  const [columnCount, masonryRef] = useColumnCount();

  const masonryColumns = useMemo(
    () =>
      distributeIntoColumns(ctl.posts, columnCount, (post) =>
        post.previewUrl && post.width && post.height
          ? post.width / post.height
          : null
      ),
    [ctl.posts, columnCount]
  );

  if (ctl.selectedPost) {
    const post = ctl.selectedPost;
    const key = explorePostKey(post);
    return (
      <ExploreDetailPanel
        post={post}
        prevPost={ctl.prevPost}
        nextPost={ctl.nextPost}
        supportsVote={ctl.siteById.get(post.siteId)?.supportsVote ?? false}
        canVote={ctl.siteById.get(post.siteId)?.canVote ?? false}
        canFavorite={ctl.siteById.get(post.siteId)?.canFavorite ?? false}
        favorited={ctl.isFavorited(post)}
        voted={ctl.voteOf(post)}
        busy={ctl.pendingActionKey === key}
        actionError={ctl.actionError}
        hasPrev={ctl.hasPrev}
        hasNext={ctl.hasNext}
        onGoRelative={ctl.goRelative}
        onClose={ctl.closeDetail}
        onVote={(score) => void ctl.votePost(post, score)}
        onFavorite={() => void ctl.favoritePost(post)}
        onSelectTag={(tag) => void ctl.selectTag(tag)}
      />
    );
  }

  return (
    <div className="page-chrome">
      <h1 className="uppercase font-semibold file-detail-section-title mb-4">
        Explore
      </h1>
      <div className="row g-4">
        <div
          className="col-12"
          onPointerDownCapture={(event) => {
            if (!ctl.isSiteFilterOpen) return;
            if (ctl.siteFilterRef.current?.contains(event.target as Node))
              return;
            ctl.setIsSiteFilterOpen(false);
          }}
        >
          <div className="card bg-transparent text-foreground border-0 h-full content-shell-card">
            <div className="card-body">
              <div className="gallery-controls flex flex-wrap items-center mb-2">
                <div className="gallery-control-group gallery-control-search flex flex-wrap items-center gap-2">
                  <label
                    className="text-muted-foreground text-sm"
                    htmlFor="explore-tag-search"
                  >
                    Search for tags:
                  </label>
                  <TagSearchInput
                    id="explore-tag-search"
                    scope="vocabulary"
                    value={ctl.tagInput}
                    onChange={ctl.setTagInput}
                    onSubmit={ctl.submitSearch}
                    placeholder="tags · ~either · -not"
                  />
                </div>
                <span
                  className="gallery-control-separator"
                  aria-hidden="true"
                />
                <div className="gallery-control-group explore-control-sort flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">
                    Order by:
                  </span>
                  <div className="btn-group btn-group-sm" role="group">
                    {SORTS.map(({ key, label, comingSoon }) => (
                      <button
                        key={key}
                        className={`btn btn-${ctl.sort === key ? 'primary' : 'outline-light'}`}
                        title={comingSoon ? 'Coming soon' : undefined}
                        onClick={() => ctl.setSort(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {ctl.sort === 'popular' ? (
                    <>
                      <select
                        id="explore-window"
                        name="explore-window"
                        className="form-select form-select-sm bg-background text-foreground border-secondary explore-window-select"
                        value={ctl.popularWindow}
                        onChange={(event) =>
                          ctl.setPopularWindow(
                            event.target.value as ExploreWindow
                          )
                        }
                        aria-label="Popular time window"
                      >
                        {WINDOWS.map((window) => (
                          <option key={window} value={window}>
                            {window}
                          </option>
                        ))}
                      </select>
                      {/* The period being shown, with a step either side — the
                      same way e621 pages through its own popular list. */}
                      <div
                        className="btn-group btn-group-sm explore-period"
                        role="group"
                        aria-label="Popular period"
                      >
                        <button
                          className="btn btn-outline-light"
                          onClick={() => ctl.stepPeriod(-1)}
                          aria-label={`Previous ${ctl.popularWindow}`}
                          title={`Previous ${ctl.popularWindow}`}
                        >
                          ‹
                        </button>
                        <span className="btn btn-outline-light explore-period-label">
                          {periodLabel(ctl.popularWindow, ctl.popularDate)}
                        </span>
                        <button
                          className="btn btn-outline-light"
                          onClick={() => ctl.stepPeriod(1)}
                          // There is nothing to show past the current period,
                          // and a booru would answer an empty page for it.
                          disabled={isCurrentPeriod(
                            ctl.popularWindow,
                            ctl.popularDate
                          )}
                          aria-label={`Next ${ctl.popularWindow}`}
                          title={`Next ${ctl.popularWindow}`}
                        >
                          ›
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
                <span
                  className="gallery-control-separator"
                  aria-hidden="true"
                />
                <div className="gallery-control-group flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">Sites:</span>
                  <div className="dropdown" ref={ctl.siteFilterRef}>
                    <button
                      className="btn btn-outline-light btn-sm dropdown-toggle"
                      type="button"
                      aria-expanded={ctl.isSiteFilterOpen}
                      onClick={() =>
                        ctl.setIsSiteFilterOpen(!ctl.isSiteFilterOpen)
                      }
                    >
                      {ctl.searchableSites.length - ctl.disabledSiteIds.size} of{' '}
                      {ctl.searchableSites.length}
                    </button>
                    {ctl.isSiteFilterOpen ? (
                      <button
                        type="button"
                        className="dropdown-backdrop"
                        aria-label="Close site filter"
                        onClick={() => ctl.setIsSiteFilterOpen(false)}
                      />
                    ) : null}
                    <div
                      className={`dropdown-menu dropdown-menu-dark p-4${ctl.isSiteFilterOpen ? ' show' : ''}`}
                    >
                      {ctl.searchableSites.length === 0 ? (
                        <div className="text-muted-foreground text-sm">
                          No searchable sites yet. Add one under Settings →
                          Favorites accounts.
                        </div>
                      ) : (
                        ctl.searchableSites.map((site) => (
                          <div className="form-check mb-2" key={site.id}>
                            <input
                              className="form-check-input"
                              type="checkbox"
                              id={`explore-site-${site.id}`}
                              name={`explore-site-${site.id}`}
                              checked={!ctl.disabledSiteIds.has(site.id)}
                              onChange={() => ctl.toggleSite(site.id)}
                            />
                            <label
                              className="form-check-label"
                              htmlFor={`explore-site-${site.id}`}
                            >
                              {site.name}
                            </label>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
                <span
                  className="gallery-control-separator"
                  aria-hidden="true"
                />
                <div className="gallery-control-group ml-auto">
                  <span className="text-muted-foreground text-sm">
                    {ctl.posts.length} posts
                  </span>
                </div>
              </div>

              <hr className="border-secondary my-4" />

              {ctl.pageState.error ? (
                <div className="text-destructive text-sm mb-2">
                  Explore: {ctl.pageState.error}
                </div>
              ) : null}
              {ctl.actionError ? (
                <div className="text-destructive text-sm mb-2">
                  {ctl.actionError}
                </div>
              ) : null}
              {/* A site that failed is named rather than silently dropped: an
              expired API key looks exactly like "no results" otherwise. */}
              {ctl.siteErrors.map((siteError) => (
                <div
                  key={siteError.siteId}
                  className="text-sm mb-2"
                  role="status"
                >
                  <span className="text-muted-foreground">
                    {siteError.siteName}:
                  </span>{' '}
                  <span className="text-destructive">{siteError.error}</span>
                </div>
              ))}

              {ctl.sort === 'subscribed' ? (
                <p className="text-muted-foreground">
                  Subscriptions are not available yet.
                </p>
              ) : ctl.posts.length === 0 ? (
                <p className="text-muted-foreground">
                  {ctl.pageState.loading || ctl.sitesLoading
                    ? 'Loading posts…'
                    : ctl.searchableSites.length === 0
                      ? 'No searchable booru sites configured yet.'
                      : 'No posts match this search.'}
                </p>
              ) : (
                <>
                  <div className="gallery-masonry" ref={masonryRef}>
                    {masonryColumns.map((column, index) => (
                      <div key={index} className="gallery-masonry-column">
                        {column.map((post) => {
                          const key = explorePostKey(post);
                          return (
                            <ExploreCard
                              key={key}
                              post={post}
                              supportsVote={
                                ctl.siteById.get(post.siteId)?.canVote ?? false
                              }
                              canFavorite={
                                ctl.siteById.get(post.siteId)?.canFavorite ??
                                false
                              }
                              favorited={ctl.isFavorited(post)}
                              voted={ctl.voteOf(post)}
                              busy={ctl.pendingActionKey === key}
                              onOpen={() => ctl.openPost(post)}
                              onVote={(score) => void ctl.votePost(post, score)}
                              onFavorite={() => void ctl.favoritePost(post)}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  {ctl.hasMore ? (
                    <div className="flex justify-center mt-4">
                      <button
                        className="btn btn-outline-light btn-sm"
                        onClick={ctl.loadMore}
                        disabled={ctl.pageState.loading}
                      >
                        {ctl.pageState.loading ? 'Loading…' : 'Load more'}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExploreCard({
  post,
  supportsVote,
  canFavorite,
  favorited,
  voted,
  busy,
  onOpen,
  onVote,
  onFavorite
}: {
  post: ExplorePost;
  supportsVote: boolean;
  canFavorite: boolean;
  favorited: boolean;
  voted: 1 | -1 | null;
  busy: boolean;
  onOpen: () => void;
  onVote: (score: 1 | -1) => void;
  onFavorite: () => void;
}) {
  const thumbRatio =
    post.previewUrl && post.width && post.height
      ? post.width / post.height
      : null;
  // Booru thumbnails are stills even for video, so without this badge a
  // clip is indistinguishable from a picture until it is opened.
  const isVideo = isVideoUrl(post.fileUrl);

  return (
    <div
      className={`gallery-thumb explore-thumb${thumbRatio ? ' is-sized' : ''}`}
      style={
        {
          '--gallery-thumb-max': `${THUMB_SIZE}px`,
          ...(thumbRatio ? { '--gallery-thumb-ratio': thumbRatio } : {})
        } as React.CSSProperties
      }
    >
      <button
        type="button"
        className="border-0 bg-transparent p-0 text-left w-full h-full"
        data-test-id="explore-card"
        aria-label={`Open post ${post.remoteId} from ${post.siteName}${
          isVideo ? ' (video)' : ''
        }${post.score !== null ? `, score ${post.score}` : ''}`}
        onClick={onOpen}
      >
        {post.previewUrl ? (
          <img
            src={post.previewUrl}
            alt={`Post ${post.remoteId} on ${post.siteName}`}
            width={post.width ?? THUMB_SIZE}
            height={post.height ?? THUMB_SIZE}
            className="gallery-thumb-img rounded"
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            // Cloudflare in front of danbooru's CDN answers 403 to a request
            // that carries no Referer at all, so its thumbnails never loaded.
            // `origin` sends the instance host and never the path, which is
            // where the search terms would sit.
            referrerPolicy="origin"
          />
        ) : (
          <div
            className="rounded flex items-center justify-center bg-background"
            style={{ height: THUMB_SIZE }}
          >
            <span className="text-muted-foreground text-sm">no preview</span>
          </div>
        )}
      </button>
      {isVideo && post.previewUrl ? (
        <Play
          aria-hidden="true"
          fill="currentColor"
          className="absolute inset-0 m-auto size-10 rounded-full bg-background/70 p-2 text-foreground"
        />
      ) : null}
      {post.score !== null ? (
        <span className="gallery-chip right-2" data-test-id="explore-score">
          <ChevronUp className="size-3" aria-hidden="true" />
          {post.score}
        </span>
      ) : null}
      {/* Which site a post came from is not guessable from the picture, and
          the merged grid interleaves them. */}
      <span className="gallery-chip left-2">{post.siteName}</span>
      <span className="explore-card-actions">
        {supportsVote ? (
          <>
            <button
              type="button"
              className={`explore-action-btn${voted === 1 ? ' is-up' : ''}`}
              aria-label="Vote up"
              aria-pressed={voted === 1}
              disabled={busy}
              onClick={() => onVote(1)}
            >
              <ChevronUp className="size-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`explore-action-btn${voted === -1 ? ' is-down' : ''}`}
              aria-label="Vote down"
              aria-pressed={voted === -1}
              disabled={busy}
              onClick={() => onVote(-1)}
            >
              <ChevronDown className="size-4" aria-hidden="true" />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={`explore-action-btn${favorited ? ' is-active' : ''}`}
          aria-label={favorited ? 'Saved to library' : 'Favorite and save'}
          aria-pressed={favorited}
          disabled={busy || favorited || !canFavorite}
          title={
            canFavorite
              ? undefined
              : `${post.siteName} cannot take favorites from this account`
          }
          onClick={onFavorite}
        >
          <Heart
            className="size-4"
            aria-hidden="true"
            fill={favorited ? 'currentColor' : 'none'}
          />
        </button>
      </span>
    </div>
  );
}
